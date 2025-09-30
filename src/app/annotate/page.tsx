import path from "path";
import { promises as fs } from "fs";

import AnnotateClient from "./AnnotateClient";

interface DocumentEntry {
  file: string;
  documentId: string;
  hasGroundTruth: boolean;
}

const TEST_DIR = path.resolve(process.cwd(), "test");

export const dynamic = "force-dynamic";

async function loadDocuments(): Promise<DocumentEntry[]> {
  try {
    const entries = await fs.readdir(TEST_DIR);
    return entries
      .filter((file) => file.toLowerCase().endsWith(".pdf"))
      .sort((a, b) => a.localeCompare(b))
      .map((file) => {
        const groundTruthFile = `${file}.groundtruth.json`;
        return {
          file,
          documentId: file.replace(/\.pdf$/i, ""),
          hasGroundTruth: entries.includes(groundTruthFile),
        };
      });
  } catch (error) {
    console.warn("Failed to read test directory", error);
    return [];
  }
}

export default async function AnnotatePage() {
  const documents = await loadDocuments();

  return (
    <div className="flex min-h-screen bg-slate-100">
      <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 py-8">
        <header className="px-6">
          <h1 className="text-2xl font-semibold text-slate-900">PDF Annotation Workbench</h1>
          <p className="mt-1 text-sm text-slate-600">
            Draw ground-truth fields on PDFs stored under <code className="rounded bg-slate-200 px-1 py-0.5">/test</code>, then export or save annotations for benchmarking.
          </p>
        </header>
        <section className="flex h-[calc(100vh-11rem)] min-h-[640px] flex-1 overflow-hidden px-6">
          <AnnotateClient documents={documents} />
        </section>
      </div>
    </div>
  );
}

