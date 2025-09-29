declare module "pdfjs-dist/legacy/build/pdf" {
  import type {
    DocumentInitParameters,
    PDFDocumentLoadingTask,
    PDFDocumentProxy,
  } from "pdfjs-dist/types/src/display/api";

  type TypedArray =
    | Int8Array
    | Uint8Array
    | Uint8ClampedArray
    | Int16Array
    | Uint16Array
    | Int32Array
    | Uint32Array
    | Float32Array
    | Float64Array;

  export function getDocument(
    src:
      | string
      | URL
      | ArrayBuffer
      | TypedArray
      | DocumentInitParameters
  ): PDFDocumentLoadingTask<PDFDocumentProxy>;

  export const GlobalWorkerOptions: {
    workerSrc: string;
  };
}
