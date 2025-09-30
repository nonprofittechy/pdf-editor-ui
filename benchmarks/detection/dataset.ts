import { promises as fs } from "fs";
import path from "path";

import type {
  DatasetLoadOptions,
  DatasetSample,
  DocumentAnnotation,
  PageAnnotation,
} from "./types";

const DEFAULT_EXTENSIONS = [".groundtruth.json", ".annotations.json", ".json"] as const;

const isPdf = (fileName: string): boolean => fileName.toLowerCase().endsWith(".pdf");

const normalizeDocument = (
  documentId: string,
  annotationPath: string,
  data: unknown
): DocumentAnnotation => {
  if (!data || typeof data !== "object") {
    throw new Error(`Annotation file ${annotationPath} must contain an object`);
  }

  const candidate = data as Partial<DocumentAnnotation> & {
    pages?: PageAnnotation[];
  };

  return {
    documentId: candidate.documentId ?? documentId,
    pages: Array.isArray(candidate.pages) ? candidate.pages : [],
    sourcePath: candidate.sourcePath,
    metadata: candidate.metadata,
  };
};

const discoverAnnotationPath = async (
  pdfPath: string,
  extensions: readonly string[]
): Promise<string | undefined> => {
  const { dir, name } = path.parse(pdfPath);

  for (const extension of extensions) {
    const candidate = path.join(dir, `${name}${extension}`);
    try {
      await fs.access(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return undefined;
};

export const loadDataset = async (
  options: DatasetLoadOptions = {}
): Promise<DatasetSample[]> => {
  const testDir = options.testDir ?? path.resolve(process.cwd(), "test");
  const extensions = options.annotationExtensions ?? [...DEFAULT_EXTENSIONS];

  let entries: string[];
  try {
    entries = await fs.readdir(testDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.warn(`Dataset directory not found: ${testDir}`);
      return [];
    }
    throw error;
  }

  const samples: DatasetSample[] = [];

  for (const entry of entries.sort()) {
    if (!isPdf(entry)) {
      continue;
    }

    const pdfPath = path.join(testDir, entry);
    const documentId = path.parse(entry).name;
    const sample: DatasetSample = {
      documentId,
      pdfPath,
    };

    const annotationPath = await discoverAnnotationPath(pdfPath, extensions);

    if (annotationPath) {
      try {
        const raw = await fs.readFile(annotationPath, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        sample.annotationPath = annotationPath;
        sample.annotations = normalizeDocument(documentId, annotationPath, parsed);
      } catch (error) {
        console.warn(
          `Failed to read annotations for ${documentId}: ${(error as Error).message}`
        );
        sample.annotationPath = annotationPath;
        sample.annotations = null;
      }
    } else {
      sample.annotations = null;
    }

    samples.push(sample);
  }

  return samples;
};

