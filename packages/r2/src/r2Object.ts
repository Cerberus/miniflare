import { Blob } from "buffer";
import crypto from "crypto";
import { arrayBuffer } from "stream/consumers";
import { ReadableStream } from "stream/web";
import { TextDecoder } from "util";
import { waitForOpenInputGate } from "@miniflare/shared";
import { Headers } from "undici";
import { R2Conditional, R2Range } from "./bucket";

export interface R2ConditionalUnparsed {
  etagMatches?: string | string[];
  etagDoesNotMatch?: string | string[];
  uploadedBefore?: string | Date;
  uploadedAfter?: string | Date;
}

/**
 * Metadata that's automatically rendered into R2 HTTP API endpoints.
 * ```
 * * contentType -> content-type
 * * contentLanguage -> content-language
 * etc...
 * ```
 * This data is echoed back on GET responses based on what was originally
 * assigned to the object (and can typically also be overriden when issuing
 * the GET request).
 */
export interface R2HTTPMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  cacheExpiry?: Date;
}

export interface R2ObjectMetadata {
  // The object’s key.
  key: string;
  // Random unique string associated with a specific upload of a key.
  version: string;
  // Size of the object in bytes.
  size: number;
  // The etag associated with the object upload.
  etag: string;
  // The object’s etag, in quotes so as to be returned as a header.
  httpEtag: string;
  // A Date object representing the time the object was uploaded.
  uploaded: Date;
  // Various HTTP headers associated with the object. Refer to HTTP Metadata.
  httpMetadata: R2HTTPMetadata;
  // A map of custom, user-defined metadata associated with the object.
  customMetadata: Record<string, string>;
  // If a GET request was made with a range option, this will be added
  range?: R2Range;
}

const decoder = new TextDecoder();

// NOTE: Incase multipart is ever added to the worker
// refer to https://stackoverflow.com/questions/12186993/what-is-the-algorithm-to-compute-the-amazon-s3-etag-for-a-file-larger-than-5gb/19896823#19896823
export function createHash(input: Uint8Array): string {
  return crypto.createHash("md5").update(input).digest("hex");
}

export function createVersion(): string {
  const size = 32;
  return crypto.randomBytes(size).toString("base64").slice(0, size);
}

// when pulling from storage, we need to convert date strings to Date objects
export function parseR2ObjectMetadata(meta: R2ObjectMetadata): void {
  meta.uploaded = new Date(meta.uploaded);
  if (meta.httpMetadata.cacheExpiry) {
    meta.httpMetadata.cacheExpiry = new Date(meta.httpMetadata.cacheExpiry);
  }
}

export function parseHttpMetadata(
  httpMetadata?: R2HTTPMetadata | Headers
): R2HTTPMetadata {
  if (httpMetadata === undefined) return {};
  if (httpMetadata instanceof Headers) {
    const cExpiry = httpMetadata.get("cache-expiry");
    return {
      contentType: httpMetadata.get("content-type") ?? undefined,
      contentLanguage: httpMetadata.get("content-language") ?? undefined,
      contentDisposition: httpMetadata.get("content-disposition") ?? undefined,
      contentEncoding: httpMetadata.get("content-encoding") ?? undefined,
      cacheControl: httpMetadata.get("cache-control") ?? undefined,
      cacheExpiry: cExpiry ? new Date(cExpiry) : undefined,
    };
  } else {
    httpMetadata = { ...httpMetadata };
    // remove variables that are not part of the HTTP metadata
    const httpMetadataList = [
      "contentType",
      "contentLanguage",
      "contentDisposition",
      "contentEncoding",
      "cacheControl",
      "cacheExpiry",
    ];
    for (const key of Object.keys(httpMetadata)) {
      if (!httpMetadataList.includes(key)) {
        delete httpMetadata[key as keyof R2HTTPMetadata];
      }
    }

    return httpMetadata;
  }
}

// false -> the condition testing "failed"
export function testR2Conditional(
  conditional: R2Conditional,
  metadata?: R2ObjectMetadata
): boolean {
  const { etagMatches, etagDoesNotMatch, uploadedBefore, uploadedAfter } =
    conditional;
  // If the object doesn't exist
  if (metadata === undefined) {
    // the etagDoesNotMatch and uploadedBefore automatically pass
    // etagMatches and uploadedAfter automatically fail if they exist
    return etagMatches === undefined && uploadedAfter === undefined;
  }

  const { etag, uploaded } = metadata;

  // ifMatch check
  const ifMatch = etagMatches ? matchStrings(etagMatches, etag) : null;
  if (ifMatch === false) return false;

  // ifNoMatch check
  const ifNoneMatch = etagDoesNotMatch
    ? !matchStrings(etagDoesNotMatch, etag)
    : null;
  if (ifNoneMatch === false) return false;

  // ifUnmodifiedSince check
  if (
    ifMatch !== true && // if "ifMatch" is true, we ignore date checking
    uploadedBefore !== undefined &&
    uploaded > uploadedBefore
  ) {
    return false;
  }

  // ifModifiedSince check
  if (
    ifNoneMatch !== true && // if "ifNoneMatch" is true, we ignore date checking
    uploadedAfter !== undefined &&
    uploaded < uploadedAfter
  ) {
    return false;
  }

  return true;
}

function matchStrings(a: string | string[], b: string): boolean {
  if (typeof a === "string") return a === b;
  else return a.includes(b);
}

// headers can be a list: e.g. ["if-match", "a, b, c"] -> "if-match: [a, b, c]"
function parseHeaderArray(input: string): string | string[] {
  // split if comma found, otherwise return input
  if (!input.includes(",")) return stripQuotes(input);
  return input.split(",").map((x) => stripQuotes(x));
}

function stripQuotes(input: string): string {
  input = input.trim();
  if (input[0] === '"') input = input.slice(1);
  if (input[input.length - 1] === '"') input = input.slice(0, -1);
  return input;
}

export function parseOnlyIf(
  onlyIf?: R2ConditionalUnparsed | R2Conditional | Headers
): R2Conditional {
  if (onlyIf === undefined) return {};
  if (onlyIf instanceof Headers) {
    onlyIf = {
      etagMatches: onlyIf.get("if-match") ?? undefined,
      etagDoesNotMatch: onlyIf.get("if-none-match") ?? undefined,
      uploadedBefore: onlyIf.get("if-unmodified-since") ?? undefined,
      uploadedAfter: onlyIf.get("if-modified-since") ?? undefined,
    };
  }
  // if string list, convert to array. e.g. 'etagMatches': 'a, b, c' -> ['a', 'b', 'c']
  if (typeof onlyIf.etagMatches === "string") {
    onlyIf.etagMatches = parseHeaderArray(onlyIf.etagMatches);
  } else if (Array.isArray(onlyIf.etagMatches)) {
    // otherwise if an array, strip the quotes
    onlyIf.etagMatches = onlyIf.etagMatches.map((x) => stripQuotes(x));
  }
  // if string list, convert to array. e.g. 'etagMatches': 'a, b, c' -> ['a', 'b', 'c']
  if (typeof onlyIf.etagDoesNotMatch === "string") {
    onlyIf.etagDoesNotMatch = parseHeaderArray(onlyIf.etagDoesNotMatch);
  } else if (Array.isArray(onlyIf.etagDoesNotMatch)) {
    // otherwise if an array, strip the quotes
    onlyIf.etagDoesNotMatch = onlyIf.etagDoesNotMatch.map((x) =>
      stripQuotes(x)
    );
  }
  // if string, convert to date
  if (typeof onlyIf.uploadedBefore === "string") {
    onlyIf.uploadedBefore = new Date(stripQuotes(onlyIf.uploadedBefore));
  }
  // if string, convert to date
  if (typeof onlyIf.uploadedAfter === "string") {
    onlyIf.uploadedAfter = new Date(stripQuotes(onlyIf.uploadedAfter));
  }

  return onlyIf as R2Conditional;
}

/**
 * R2Object is created when you PUT an object into an R2 bucket.
 * R2Object represents the metadata of an object based on the information
 * provided by the uploader. Every object that you PUT into an R2 bucket
 * will have an R2Object created.
 */
export class R2Object {
  // The object’s key.
  readonly key: string;
  // Random unique string associated with a specific upload of a key.
  readonly version: string;
  // Size of the object in bytes.
  readonly size: number;
  // The etag associated with the object upload.
  readonly etag: string;
  // The object’s etag, in quotes so as to be returned as a header.
  readonly httpEtag: string;
  // A Date object representing the time the object was uploaded.
  readonly uploaded: Date;
  // Various HTTP headers associated with the object. Refer to
  // https://developers.cloudflare.com/r2/runtime-apis/#http-metadata.
  readonly httpMetadata: R2HTTPMetadata;
  // A map of custom, user-defined metadata associated with the object.
  readonly customMetadata: Record<string, string>;
  // If a GET request was made with a range option, this will be added
  readonly range?: R2Range;
  constructor(metadata: R2ObjectMetadata) {
    this.key = metadata.key;
    this.version = metadata.version;
    this.size = metadata.size;
    this.etag = metadata.etag;
    this.httpEtag = metadata.httpEtag;
    this.uploaded = metadata.uploaded;
    this.httpMetadata = metadata.httpMetadata;
    this.customMetadata = metadata.customMetadata;
    this.range = metadata.range;
  }

  // Retrieves the httpMetadata from the R2Object and applies their corresponding
  // HTTP headers to the Headers input object. Refer to HTTP Metadata.
  writeHttpMetadata(headers: Headers): void {
    for (const [key, value] of Object.entries(this.httpMetadata)) {
      const camelToDash = key.replace(/([A-Z])/g, "-$1").toLowerCase();
      headers.set(camelToDash, value);
    }
  }
}

export class R2ObjectBody extends R2Object {
  // The object’s value.
  readonly body: ReadableStream<Uint8Array>;
  // Whether the object’s value has been consumed or not.
  readonly bodyUsed: boolean = false;
  constructor(metadata: R2ObjectMetadata, value: Uint8Array) {
    super(metadata);

    // To maintain readonly, we build this clever work around to update upon consumption.
    const setBodyUsed = (): void => {
      (this.bodyUsed as R2ObjectBody["bodyUsed"]) = true;
    };

    // convert value to readable stream
    this.body = new ReadableStream<Uint8Array>({
      type: "bytes" as any,
      // Delay enqueuing chunk until it's actually requested so we can wait
      // for the input gate to open before delivering it
      async pull(controller) {
        await waitForOpenInputGate();
        if (value.byteLength) controller.enqueue(value);
        controller.close();
        // Not documented in MDN but if there's an ongoing request that's waiting,
        // we need to tell it that there were 0 bytes delivered so that it unblocks
        // and notices the end of stream.
        // @ts-expect-error `byobRequest` has type `undefined` in `@types/node`
        controller.byobRequest?.respond(0);
        setBodyUsed();
      },
    });
  }

  // Returns a Promise that resolves to an ArrayBuffer containing the object’s value.
  async arrayBuffer(): Promise<ArrayBuffer> {
    if (this.bodyUsed) throw new TypeError("Body already used.");

    // @ts-expect-error ReadableStream is missing properties
    return arrayBuffer(this.body);
  }

  // Returns a Promise that resolves to an string containing the object’s value.
  async text(): Promise<string> {
    return decoder.decode(await this.arrayBuffer());
  }

  // Returns a Promise that resolves to the given object containing the object’s value.
  async json<T>(): Promise<T> {
    return JSON.parse(await this.text());
  }

  // Returns a Promise that resolves to a binary Blob containing the object’s value.
  async blob(): Promise<Blob> {
    const ab = await this.arrayBuffer();
    return new Blob([new Uint8Array(ab)]);
  }
}
