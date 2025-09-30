'use client';

import { useEffect, useMemo, useRef, useState } from "react";

import type { NormalizedRect } from "@/types/form";

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf");
type PdfPageProxy = Awaited<ReturnType<PdfJsModule["getDocument"]>["promise"]>["getPage"] extends (
  ...args: any
) => Promise<infer R>
  ? R
  : never;

interface DocumentEntry {
  file: string;
  documentId: string;
  hasGroundTruth: boolean;
}

interface AnnotateClientProps {
  documents: DocumentEntry[];
}

type FieldTypeOption = "text" | "checkbox" | "radio" | "dropdown" | "signature";

interface PageField {
  id: string;
  type: FieldTypeOption;
  rect: NormalizedRect;
}

interface PageState {
  size: { width: number; height: number };
  fields: PageField[];
}

const FIELD_OPTIONS: Array<{ value: FieldTypeOption; label: string }> = [
  { value: "text", label: "Text" },
  { value: "checkbox", label: "Checkbox" },
  { value: "radio", label: "Radio" },
  { value: "dropdown", label: "Select" },
  { value: "signature", label: "Signature" },
];

const RENDER_SCALE = 1.75;

let pdfjsModulePromise: Promise<PdfJsModule> | null = null;

const loadPdfJs = async (): Promise<PdfJsModule> => {
  if (!pdfjsModulePromise) {
    pdfjsModulePromise = import("pdfjs-dist/legacy/build/pdf").then((m) => m as PdfJsModule);
  }
  return pdfjsModulePromise;
};

const formatCoordinate = (value: number) => value.toFixed(3);

const AnnotateClient = ({ documents }: AnnotateClientProps) => {
  const [selectedDocument, setSelectedDocument] = useState<DocumentEntry | null>(
    documents[0] ?? null
  );
  const [pdfProxy, setPdfProxy] = useState<Awaited<ReturnType<PdfJsModule["getDocument"]>["promise"]> | null>(
    null
  );
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [pageStates, setPageStates] = useState<Record<number, PageState>>({});
  const [activeFieldType, setActiveFieldType] = useState<FieldTypeOption>("text");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftRect, setDraftRect] = useState<NormalizedRect | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPoint, setStartPoint] = useState<{ x: number; y: number } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const currentPageState = pageStates[currentPageIndex];
  const renderDimensions = currentPageState?.size
    ? {
        width: currentPageState.size.width * RENDER_SCALE,
        height: currentPageState.size.height * RENDER_SCALE,
      }
    : { width: 0, height: 0 };

  useEffect(() => {
    if (!selectedDocument) return;

    setIsLoading(true);
    setError(null);
    setDraftRect(null);
    setPageStates({});
    setCurrentPageIndex(0);

    let cancelled = false;
    let pdfInstance: Awaited<ReturnType<PdfJsModule["getDocument"]>["promise"]> | null = null;

    (async () => {
      try {
        const pdfjs = await loadPdfJs();
        if (pdfjs.GlobalWorkerOptions) {
          pdfjs.GlobalWorkerOptions.workerSrc = `/pdf.worker.min.mjs`;
          pdfjs.GlobalWorkerOptions.disableWorker = false;
        }
        const task = pdfjs.getDocument({
          url: `/api/annotate/pdf?file=${encodeURIComponent(selectedDocument.file)}`,
        });
        pdfInstance = await task.promise;
        if (cancelled) {
          await pdfInstance.destroy();
          return;
        }
        setPdfProxy(pdfInstance);
      } catch (err) {
        console.error(err);
        setError("Unable to load PDF document. Please check the console for details.");
        setPdfProxy(null);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (pdfInstance) {
        void pdfInstance.destroy();
      }
    };
  }, [selectedDocument]);

  useEffect(() => {
    if (!pdfProxy) return;

    let cancelled = false;

    (async () => {
      try {
        const page = await pdfProxy.getPage(currentPageIndex + 1);
        if (cancelled) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const renderViewport = page.getViewport({ scale: RENDER_SCALE });

        const canvas = canvasRef.current;
        if (!canvas) return;

        const context = canvas.getContext("2d");
        if (!context) return;

        canvas.width = renderViewport.width;
        canvas.height = renderViewport.height;

        await page.render({ canvasContext: context, viewport: renderViewport }).promise;

        setPageStates((prev) => ({
          ...prev,
          [currentPageIndex]: prev[currentPageIndex] ?? {
            size: { width: baseViewport.width, height: baseViewport.height },
            fields: [],
          },
        }));

        if (overlayRef.current) {
          overlayRef.current.style.width = `${renderViewport.width}px`;
          overlayRef.current.style.height = `${renderViewport.height}px`;
        }
      } catch (err) {
        console.error(err);
        setError("Failed to render the selected page.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pdfProxy, currentPageIndex]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!overlayRef.current || !currentPageState) return;
    if (event.button !== 0) return;

    const bounds = overlayRef.current.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;

    setIsDrawing(true);
    setStartPoint({ x, y });
    setDraftRect({ x: 0, y: 0, width: 0, height: 0 });
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDrawing || !startPoint || !overlayRef.current) return;

    event.preventDefault();

    const bounds = overlayRef.current.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;

    const widthPx = Math.max(0, x - startPoint.x);
    const heightPx = Math.max(0, y - startPoint.y);

    const normalizedWidth = widthPx / renderDimensions.width;
    const normalizedHeight = heightPx / renderDimensions.height;

    setDraftRect({
      x: startPoint.x / renderDimensions.width,
      y: startPoint.y / renderDimensions.height,
      width: normalizedWidth,
      height: normalizedHeight,
    });
  };

  const handlePointerUp = () => {
    if (!isDrawing || !draftRect || !currentPageState) {
      setIsDrawing(false);
      setDraftRect(null);
      return;
    }

    const minDimension = 0.01; // ~1% of page
    if (draftRect.width < minDimension || draftRect.height < minDimension) {
      setIsDrawing(false);
      setDraftRect(null);
      return;
    }

    const id = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `field-${Date.now()}`;

    setPageStates((prev) => {
      const page = prev[currentPageIndex] ?? {
        size: currentPageState.size,
        fields: [],
      };
      return {
        ...prev,
        [currentPageIndex]: {
          size: page.size,
          fields: [
            ...page.fields,
            {
              id,
              type: activeFieldType,
              rect: draftRect,
            },
          ],
        },
      };
    });

    setIsDrawing(false);
    setDraftRect(null);
    setStartPoint(null);
  };

  const handleRemoveField = (pageIndex: number, fieldId: string) => {
    setPageStates((prev) => {
      const page = prev[pageIndex];
      if (!page) return prev;
      return {
        ...prev,
        [pageIndex]: {
          ...page,
          fields: page.fields.filter((field) => field.id !== fieldId),
        },
      };
    });
  };

  const annotationPayload = useMemo(() => {
    if (!selectedDocument) return null;

    const pages = Object.entries(pageStates)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([index, state]) => ({
        pageIndex: Number(index),
        width: state.size.width,
        height: state.size.height,
        fields: state.fields.map((field) => ({
          id: field.id,
          type: field.type,
          rect: field.rect,
        })),
      }))
      .filter((page) => page.fields.length > 0);

    return {
      documentId: selectedDocument.documentId,
      pages,
    };
  }, [pageStates, selectedDocument]);

  const handleDownload = () => {
    if (!annotationPayload || annotationPayload.pages.length === 0) {
      alert("Add at least one field before exporting.");
      return;
    }

    const blob = new Blob([JSON.stringify(annotationPayload, null, 2)], {
      type: "application/json",
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${selectedDocument?.file ?? "annotation"}.groundtruth.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const handleSave = async () => {
    if (!annotationPayload || annotationPayload.pages.length === 0 || !selectedDocument) {
      alert("Add at least one field before saving.");
      return;
    }

    try {
      const response = await fetch("/api/annotate/save", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          pdfFile: selectedDocument.file,
          annotation: annotationPayload,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? response.statusText);
      }
      alert("Annotations saved successfully.");
    } catch (err) {
      console.error(err);
      alert(`Failed to save annotations: ${(err as Error).message}`);
    }
  };

  const renderFieldsOverlay = (fields: PageField[]) => {
    return fields.map((field) => {
      const x = field.rect.x * renderDimensions.width;
      const y = field.rect.y * renderDimensions.height;
      const width = field.rect.width * renderDimensions.width;
      const height = field.rect.height * renderDimensions.height;

      return (
        <div
          key={field.id}
          className="pointer-events-none absolute border border-sky-500/80 bg-sky-400/10"
          style={{
            left: `${x}px`,
            top: `${y}px`,
            width: `${width}px`,
            height: `${height}px`,
          }}
        />
      );
    });
  };

  const renderDraftRect = () => {
    if (!draftRect) return null;
    return (
      <div
        className="pointer-events-none absolute border border-indigo-500/80 bg-indigo-400/10"
        style={{
          left: `${draftRect.x * renderDimensions.width}px`,
          top: `${draftRect.y * renderDimensions.height}px`,
          width: `${draftRect.width * renderDimensions.width}px`,
          height: `${draftRect.height * renderDimensions.height}px`,
        }}
      />
    );
  };

  return (
    <div className="flex h-full w-full gap-6">
      <aside className="w-64 overflow-y-auto rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-medium text-slate-900">Test PDFs</h2>
        <ul className="mt-3 space-y-1 text-sm">
          {documents.map((doc) => {
            const isSelected = selectedDocument?.file === doc.file;
            return (
              <li key={doc.file}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedDocument(doc);
                    setPageStates({});
                  }}
                  className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left transition hover:bg-slate-100 ${
                    isSelected ? "bg-slate-200 font-medium" : "bg-transparent"
                  }`}
                >
                  <span className="truncate">{doc.file}</span>
                  {doc.hasGroundTruth && (
                    <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-700">
                      GT
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="mt-6 space-y-2 text-xs text-slate-600">
          <p>
            Draw rectangles on the PDF canvas, choose a field type, then export or save your annotations.
          </p>
          <p>
            Saved files will appear beside the PDF as <code className="rounded bg-slate-200 px-1">.groundtruth.json</code>.
          </p>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium text-slate-700">Field type</label>
            <select
              className="rounded border border-slate-300 bg-white px-2 py-1 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              value={activeFieldType}
              onChange={(event) => setActiveFieldType(event.target.value as FieldTypeOption)}
            >
              {FIELD_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {annotationPayload && (
              <span className="text-xs text-slate-500">
                {annotationPayload.pages.reduce((acc, page) => acc + page.fields.length, 0)} field(s) annotated
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleDownload}
              className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            >
              Export JSON
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="rounded border border-indigo-600 px-3 py-1.5 text-sm font-medium text-indigo-600 transition hover:bg-indigo-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            >
              Save to test/
            </button>
          </div>
        </div>

        <div className="flex flex-1 gap-4 overflow-hidden">
          <div className="relative flex flex-1 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2 text-sm">
              <div>
                <span className="font-medium text-slate-900">
                  {selectedDocument?.file ?? "No PDF selected"}
                </span>
                {selectedDocument && (
                  <span className="ml-2 text-xs text-slate-500">Page {currentPageIndex + 1}</span>
                )}
              </div>
              {pdfProxy && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="rounded border border-slate-300 px-2 py-1 text-xs transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-400"
                    disabled={currentPageIndex === 0}
                    onClick={() => setCurrentPageIndex((prev) => Math.max(0, prev - 1))}
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    className="rounded border border-slate-300 px-2 py-1 text-xs transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-400"
                    disabled={currentPageIndex >= (pdfProxy?.numPages ?? 1) - 1}
                    onClick={() =>
                      setCurrentPageIndex((prev) =>
                        Math.min((pdfProxy?.numPages ?? 1) - 1, prev + 1)
                      )
                    }
                  >
                    Next
                  </button>
                </div>
              )}
            </div>

            <div className="relative flex flex-1 justify-center overflow-auto bg-slate-50 p-4">
              {error ? (
                <div className="flex h-full w-full items-center justify-center text-sm text-red-600">
                  {error}
                </div>
              ) : isLoading ? (
                <div className="flex h-full w-full items-center justify-center text-sm text-slate-600">
                  Loading PDF…
                </div>
              ) : (
                <div className="relative" style={{ width: renderDimensions.width || 0 }}>
                  <canvas ref={canvasRef} className="block drop-shadow" />
                  <div
                    ref={overlayRef}
                    className="absolute inset-0 cursor-crosshair"
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerLeave={handlePointerUp}
                  >
                    {currentPageState && renderFieldsOverlay(currentPageState.fields)}
                    {renderDraftRect()}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="w-72 overflow-y-auto rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="text-sm font-medium text-slate-900">Page Fields</h3>
            <div className="mt-3 space-y-2 text-xs text-slate-600">
              {currentPageState && currentPageState.fields.length > 0 ? (
                currentPageState.fields.map((field) => (
                  <div
                    key={field.id}
                    className="rounded border border-slate-200 p-2 shadow-sm"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-slate-800">{field.type}</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveField(currentPageIndex, field.id)}
                        className="text-[11px] font-medium text-rose-600 hover:text-rose-500"
                      >
                        Remove
                      </button>
                    </div>
                    <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-1">
                      <span>X: {formatCoordinate(field.rect.x)}</span>
                      <span>Y: {formatCoordinate(field.rect.y)}</span>
                      <span>W: {formatCoordinate(field.rect.width)}</span>
                      <span>H: {formatCoordinate(field.rect.height)}</span>
                    </div>
                  </div>
                ))
              ) : (
                <p>No fields on this page yet.</p>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default AnnotateClient;
