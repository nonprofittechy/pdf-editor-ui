import type { FieldType, NormalizedRect } from "../../src/types/form";

export interface FieldAnnotation {
  /** Optional identifier that stays stable across revisions */
  id?: string;
  type: FieldType;
  rect: NormalizedRect;
  /** Arbitrary metadata gathered during labeling */
  attributes?: Record<string, unknown>;
}

export interface PageAnnotation {
  pageIndex: number;
  /** Optional absolute measurements in PDF units */
  width?: number;
  height?: number;
  fields: FieldAnnotation[];
}

export interface DocumentAnnotation {
  documentId: string;
  pages: PageAnnotation[];
  /** Reference to the source file on disk */
  sourcePath?: string;
  metadata?: Record<string, unknown>;
}

export interface FieldPrediction extends FieldAnnotation {
  confidence?: number;
  /** Detector-specific auxiliary output */
  extra?: Record<string, unknown>;
}

export interface PagePrediction {
  pageIndex: number;
  fields: FieldPrediction[];
}

export interface DetectionOutput {
  documentId: string;
  pages: PagePrediction[];
  summary?: Record<string, unknown>;
}

export interface DatasetSample {
  documentId: string;
  pdfPath: string;
  annotationPath?: string;
  annotations?: DocumentAnnotation | null;
}

export interface DatasetLoadOptions {
  /** Override the default ./test dataset root */
  testDir?: string;
  /** Candidate extensions for ground-truth metadata */
  annotationExtensions?: string[];
}

