"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DocumentInitParameters,
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist/types/src/display/api";
import { v4 as uuid } from "uuid";
import {
  AnnotationFlags,
  PDFButton,
  PDFCheckBox,
  PDFDocument,
  PDFAcroSignature,
  PDFDropdown,
  PDFFont,
  PDFOptionList,
  PDFRadioGroup,
  PDFSignature,
  PDFTextField,
  PDFName,
  PDFWidgetAnnotation,
  StandardFonts,
  createPDFAcroFields,
} from "pdf-lib";
import type { FieldFont, FieldType, NormalizedRect, PdfField } from "@/types/form";

type PdfJsModule = {
  getDocument: (
    src:
      | string
      | URL
      | ArrayBuffer
      | Uint8Array
      | DocumentInitParameters
  ) => PDFDocumentLoadingTask;
  GlobalWorkerOptions: {
    workerSrc: string;
  };
};

let pdfjsModulePromise: Promise<PdfJsModule> | null = null;

const loadPdfJs = async (): Promise<PdfJsModule> => {
  if (!pdfjsModulePromise) {
    pdfjsModulePromise = import("pdfjs-dist/legacy/build/pdf").then(
      (module) => module as PdfJsModule
    );
  }
  return pdfjsModulePromise;
};

const AVAILABLE_FONTS: FieldFont[] = [
  "Helvetica",
  "Helvetica-Bold",
  "Times-Roman",
  "Times-Bold",
  "Courier",
  "Courier-Bold",
];

const ALL_FIELD_TYPES: Record<FieldType, string> = {
  text: "Single-line Text",
  multiline: "Multi-line Text",
  checkbox: "Checkbox",
  signature: "Signature",
  radio: "Radio Group",
  dropdown: "Dropdown",
  listbox: "List Box",
  button: "Button",
};

const TYPE_OPTIONS = (Object.entries(ALL_FIELD_TYPES) as Array<[FieldType, string]>).map(
  ([value, label]) => ({ value, label })
);

const TOOL_LABELS: Record<string, string> = {
  text: "Single-line Text",
  multiline: "Multi-line Text",
  checkbox: "Checkbox",
  signature: "Signature",
  radio: "Radio Group",
  dropdown: "Dropdown",
  listbox: "List Box",
};


type PageMeasurement = {
  width: number;
  height: number;
};

type PendingDraw = {
  pageIndex: number;
  start: { x: number; y: number };
  current: { x: number; y: number };
};

type DragState = {
  pageIndex: number;
  fieldId: string;
  pointerId: number;
  offset: { x: number; y: number };
};

type PdfPageProps = {
  pdf: PDFDocumentProxy;
  pageIndex: number;
  renderScale: number;
  fields: PdfField[];
  selectedTool: FieldType | null;
  onCreateField: (pageIndex: number, rect: NormalizedRect) => void;
  onSelectField: (id: string) => void;
  onMoveField: (fieldId: string, rect: NormalizedRect) => void;
  selectedFieldId: string | null;
};

type AcroParentNode = {
  addField: (ref: unknown) => void;
  normalizedEntries: () => {
    Kids?: Parameters<typeof createPDFAcroFields>[0];
    Fields?: Parameters<typeof createPDFAcroFields>[0];
  };
};

const isTextType = (type: FieldType) => type === "text" || type === "multiline";

const isOptionType = (type: FieldType) =>
  type === "radio" || type === "dropdown" || type === "listbox";

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const normalizeExistingRect = (
  rect: { x: number; y: number; width: number; height: number },
  page: PageMeasurement
): NormalizedRect => {
  const normalizedWidth = clamp(rect.width / page.width, 0.02, 1);
  const normalizedHeight = clamp(rect.height / page.height, 0.02, 1);
  const normalizedX = clamp(rect.x / page.width, 0, 1 - normalizedWidth);
  const normalizedY = clamp(
    1 - (rect.y + rect.height) / page.height,
    0,
    1 - normalizedHeight
  );

  return {
    x: normalizedX,
    y: normalizedY,
    width: normalizedWidth,
    height: normalizedHeight,
  };
};

const mapExistingFields = async (
  bytes: Uint8Array,
  pageSizes: PageMeasurement[]
): Promise<PdfField[]> => {
  try {
    const pdfDoc = await PDFDocument.load(bytes);
    const form = pdfDoc.getForm();
    const pdfPages = pdfDoc.getPages();
    const seenNames = new Set<string>();
    const collected: PdfField[] = [];

    form.getFields().forEach((field) => {
      let type: FieldType | null = null;
      let options: string[] | undefined = undefined;

      if (field instanceof PDFTextField) {
        type = field.isMultiline() ? "multiline" : "text";
      } else if (field instanceof PDFCheckBox) {
        type = "checkbox";
      } else if (field instanceof PDFSignature) {
        type = "signature";
      } else if (field instanceof PDFRadioGroup) {
        type = "radio";
        options = field.getOptions();
      } else if (field instanceof PDFDropdown) {
        type = "dropdown";
        options = field.getOptions();
      } else if (field instanceof PDFOptionList) {
        type = "listbox";
        options = field.getOptions();
      } else if (field instanceof PDFButton) {
        type = "button";
      }

      if (!type) return;

      const widgets = field.acroField.getWidgets();
      if (!widgets.length) return;

      if (type === "radio") {
        const widgetRects = widgets
          .map((w) => w.getRectangle())
          .filter(Boolean) as { x: number; y: number; width: number; height: number }[];
        if (widgetRects.length === 0) return;

        const pageRef = widgets[0].P();
        let pageIndex = 0;
        if (pageRef) {
          const foundIndex = pdfPages.findIndex(
            (page) => ((page as unknown as { ref?: unknown }).ref ?? null) === pageRef
          );
          if (foundIndex >= 0) {
            pageIndex = foundIndex;
          }
        }
        const size = pageSizes[pageIndex] ?? pdfPages[pageIndex].getSize();
        const normalizedWidgetRects = widgetRects.map((r) => normalizeExistingRect(r, size));

        const minX = Math.min(...normalizedWidgetRects.map((r) => r.x));
        const minY = Math.min(...normalizedWidgetRects.map((r) => r.y));
        const maxX = Math.max(...normalizedWidgetRects.map((r) => r.x + r.width));
        const maxY = Math.max(...normalizedWidgetRects.map((r) => r.y + r.height));

        const encompassingRect = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };

        const baseName = field.getName() || defaultNameForType(type, collected);
        const displayName = ensureUniqueFieldName(baseName, seenNames);

        collected.push({
          id: uuid(),
          name: displayName,
          type,
          pageIndex,
          rect: encompassingRect,
          options,
          widgetRects: normalizedWidgetRects,
          autoSize: true,
          font: "Helvetica",
          fontSize: 12,
        });
      } else {
        widgets.forEach((widget) => {
          const rectangle = widget.getRectangle();
          if (!rectangle) return;

          const pageRef = widget.P();
          let pageIndex = 0;
          if (pageRef) {
            const foundIndex = pdfPages.findIndex(
              (page) => ((page as unknown as { ref?: unknown }).ref ?? null) === pageRef
            );
            if (foundIndex >= 0) {
              pageIndex = foundIndex;
            }
          }

          const size = pageSizes[pageIndex] ?? pdfPages[pageIndex].getSize();
          const rect = normalizeExistingRect(rectangle, {
            width: size.width,
            height: size.height,
          });

          const baseName = field.getName() || defaultNameForType(type!, collected);
          const displayName = ensureUniqueFieldName(baseName, seenNames);

          collected.push({
            id: uuid(),
            name: displayName,
            type: type as FieldType,
            pageIndex,
            rect,
            options,
            autoSize: true,
            font: "Helvetica",
            fontSize: 12,
          });
        });
      }
    });

    return collected;
  } catch (error) {
    console.warn("Unable to parse existing form fields", error);
    return [];
  }
};

const PdfPage = ({
  pdf,
  pageIndex,
  renderScale,
  fields,
  selectedTool,
  onCreateField,
  onSelectField,
  onMoveField,
  selectedFieldId,
}: PdfPageProps) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [renderDimensions, setRenderDimensions] = useState<PageMeasurement | null>(null);
  const pendingDrawRef = useRef<PendingDraw | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const [draftRect, setDraftRect] = useState<NormalizedRect | null>(null);

  useEffect(() => {
    let isCancelled = false;
    let renderTask: RenderTask | null = null;

    const renderPage = async () => {
      try {
        const page = await pdf.getPage(pageIndex + 1);
        if (isCancelled) return;
        const viewport = page.getViewport({ scale: renderScale });
        const canvas = canvasRef.current;
        if (!canvas) return;
        const context = canvas.getContext("2d");
        if (!context) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        if (!isCancelled) {
          setRenderDimensions({ width: viewport.width, height: viewport.height });
        }
        renderTask = page.render({
          canvasContext: context,
          canvas,
          viewport,
        });
        await renderTask.promise;
      } catch (renderError) {
        if ((renderError as { name?: string }).name === "RenderingCancelledException") {
          return;
        }
        console.error("Failed to render PDF page", renderError);
      }
    };

    renderPage().catch((error) => {
      console.error("Failed to render PDF page", error);
    });

    return () => {
      isCancelled = true;
      if (renderTask) {
        renderTask.cancel();
      }
    };
  }, [pdf, pageIndex, renderScale]);

  const normalizePoint = useCallback(
    (event: PointerEvent | React.PointerEvent) => {
      const container = containerRef.current;
      if (!container) {
        return { x: 0, y: 0 };
      }
      const rect = container.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      return { x, y };
    },
    []
  );

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    if (event.button !== 0) return;

    if (selectedTool) {
      const point = normalizePoint(event);
      const pending: PendingDraw = {
        pageIndex,
        start: point,
        current: point,
      };
      pendingDrawRef.current = pending;
      setDraftRect({ x: point.x, y: point.y, width: 0, height: 0 });
      containerRef.current.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
  };

  const finalizeDraw = useCallback(() => {
    const pending = pendingDrawRef.current;
    if (!pending) return;
    const { start, current } = pending;
    const x = Math.min(start.x, current.x);
    const y = Math.min(start.y, current.y);
    const width = Math.abs(current.x - start.x);
    const height = Math.abs(current.y - start.y);
    pendingDrawRef.current = null;
    setDraftRect(null);
    if (width < 0.02 || height < 0.02) {
      return;
    }
    onCreateField(pageIndex, {
      x: clamp(x, 0, 1),
      y: clamp(y, 0, 1),
      width: clamp(width, 0.02, 1),
      height: clamp(height, 0.02, 1),
    });
  }, [onCreateField, pageIndex]);

  const updateDraftRect = useCallback(() => {
    const pending = pendingDrawRef.current;
    if (!pending) return;
    const { start, current } = pending;
    setDraftRect({
      x: Math.min(start.x, current.x),
      y: Math.min(start.y, current.y),
      width: Math.abs(current.x - start.x),
      height: Math.abs(current.y - start.y),
    });
  }, []);

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const pending = pendingDrawRef.current;
    const dragState = dragStateRef.current;
    if (!containerRef.current) return;

    if (pending) {
      const point = normalizePoint(event);
      pending.current = point;
      updateDraftRect();
      return;
    }

    if (dragState) {
      const point = normalizePoint(event);
      const field = fields.find((f) => f.id === dragState.fieldId);
      if (!field) return;
      const newX = clamp(point.x - dragState.offset.x, 0, 1 - field.rect.width);
      const newY = clamp(point.y - dragState.offset.y, 0, 1 - field.rect.height);
      onMoveField(field.id, { ...field.rect, x: newX, y: newY });
    }
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (container && container.hasPointerCapture(event.pointerId)) {
      container.releasePointerCapture(event.pointerId);
    }

    if (dragStateRef.current) {
      dragStateRef.current = null;
    }

    if (pendingDrawRef.current) {
      finalizeDraw();
    }
  };

  useEffect(() => {
    const handlePointerMoveWindow = (event: PointerEvent) => {
      const pending = pendingDrawRef.current;
      const dragState = dragStateRef.current;
      if (!pending && !dragState) return;
      if (!containerRef.current) return;
      const point = normalizePoint(event);
      if (pending) {
        pending.current = point;
        updateDraftRect();
      } else if (dragState) {
        const field = fields.find((f) => f.id === dragState.fieldId);
        if (!field) return;
        const newX = clamp(point.x - dragState.offset.x, 0, 1 - field.rect.width);
        const newY = clamp(point.y - dragState.offset.y, 0, 1 - field.rect.height);
        onMoveField(field.id, { ...field.rect, x: newX, y: newY });
      }
    };

    const handlePointerUpWindow = () => {
      if (pendingDrawRef.current) {
        finalizeDraw();
      }
      dragStateRef.current = null;
      pendingDrawRef.current = null;
      setDraftRect(null);
    };

    window.addEventListener("pointermove", handlePointerMoveWindow);
    window.addEventListener("pointerup", handlePointerUpWindow);
    return () => {
      window.removeEventListener("pointermove", handlePointerMoveWindow);
      window.removeEventListener("pointerup", handlePointerUpWindow);
    };
  }, [fields, finalizeDraw, normalizePoint, onMoveField, updateDraftRect]);

  const handleFieldPointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
    field: PdfField
  ) => {
    event.stopPropagation();
    if (selectedTool) return;
    onSelectField(field.id);
    const point = normalizePoint(event);
    dragStateRef.current = {
      pageIndex,
      fieldId: field.id,
      pointerId: event.pointerId,
      offset: {
        x: point.x - field.rect.x,
        y: point.y - field.rect.y,
      },
    };
    const container = containerRef.current;
    if (container) {
      container.setPointerCapture(event.pointerId);
    }
  };

  const renderRect = (rect: NormalizedRect) => {
    if (!renderDimensions) return { left: 0, top: 0, width: 0, height: 0 };
    return {
      left: `${rect.x * 100}%`,
      top: `${rect.y * 100}%`,
      width: `${rect.width * 100}%`,
      height: `${rect.height * 100}%`,
    };
  };

  return (
    <div
      ref={containerRef}
      className="relative border border-slate-300 bg-white shadow-sm"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      role="presentation"
    >
      <canvas ref={canvasRef} className="block w-full h-auto" />
      <div className="absolute inset-0">
        {fields.map((field) => (
          <div
            key={field.id}
            className={`absolute rounded ${
              selectedFieldId === field.id
                ? "border-2 border-blue-600 bg-blue-500/20"
                : "border border-sky-400 bg-sky-300/10 hover:border-sky-500"
            } cursor-move`}
            style={renderRect(field.rect)}
            onPointerDown={(event) => handleFieldPointerDown(event, field)}
          >
            <span className="absolute left-1 top-1 bg-slate-800/80 text-white text-xs px-1 py-px rounded">
              {field.name}
            </span>
          </div>
        ))}
        {draftRect ? (
          <div
            className="absolute border-2 border-dashed border-amber-500 bg-amber-400/10"
            style={renderRect(draftRect)}
          />
        ) : null}
      </div>
    </div>
  );
};

type FieldListProps = {
  fields: PdfField[];
  selectedFieldId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (id: string, updates: Partial<PdfField>) => void;
  onDelete: (id: string) => void;
  recentlyDeleted: PdfField | null;
  onUndoDelete: () => void;
};

const FieldList = ({
  fields,
  selectedFieldId,
  onSelect,
  onChange,
  onDelete,
  recentlyDeleted,
  onUndoDelete,
}: FieldListProps) => {
  const handleFontChange = (field: PdfField, font: FieldFont) => {
    onChange(field.id, { font });
  };

  const handleFontSizeChange = (field: PdfField, value: string) => {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      onChange(field.id, { fontSize: clamp(parsed, 4, 72) });
    }
  };

  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    if (!selectedFieldId) return;
    const node = itemRefs.current[selectedFieldId];
    if (node) {
      node.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selectedFieldId]);

  const handleConfirmDelete = (id: string) => {
    if (window.confirm("Are you sure you want to delete this field?")) {
      onDelete(id);
    }
  };

  return (
    <div className="flex h-full flex-col gap-4">
      <h2 className="text-lg font-semibold text-slate-800">Fields</h2>
      {recentlyDeleted ? (
        <div className="flex items-center justify-between rounded border border-amber-300 bg-amber-50 p-2 text-sm">
          <span className="text-amber-800">
            Deleted <strong>{recentlyDeleted.name}</strong>
          </span>
          <button
            type="button"
            onClick={onUndoDelete}
            className="rounded bg-amber-100 px-2 py-1 font-semibold text-amber-800 hover:bg-amber-200"
          >
            Undo
          </button>
        </div>
      ) : null}
      {fields.length === 0 ? (
        <p className="text-sm text-slate-500">
          Use the tools to draw fields on the PDF. They will appear here for quick editing.
        </p>
      ) : (
        <div className="flex flex-col gap-3 overflow-y-auto pr-2">
          {fields.map((field) => {
            const isText = isTextType(field.type);
            const isSelected = selectedFieldId === field.id;
            return (
              <div
                key={field.id}
                ref={(el) => (itemRefs.current[field.id] = el)}
                className={`rounded border ${
                  isSelected ? "border-blue-600 shadow-md" : "border-slate-200"
                } bg-white text-sm transition-all`}
              >
                <div
                  className={`flex cursor-pointer items-start justify-between gap-2 rounded-t p-3 ${
                    isSelected ? "bg-blue-100" : "hover:bg-slate-50"
                  }`}
                  onClick={() => onSelect(isSelected ? null : field.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      onSelect(isSelected ? null : field.id);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <span className="font-medium text-slate-800">{field.name}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleConfirmDelete(field.id);
                    }}
                    className="rounded bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-600 hover:bg-rose-100"
                  >
                    Delete
                  </button>
                </div>
                {isSelected ? (
                  <div className="grid grid-cols-1 gap-3 border-t border-slate-200 p-3">
                    <label className="flex flex-col gap-1">
                      <span className="text-xs uppercase text-slate-500">Field Name</span>
                      <input
                        type="text"
                        value={field.name}
                        onChange={(event) => onChange(field.id, { name: event.target.value })}
                        className="rounded border border-slate-300 px-2 py-1 text-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-xs uppercase text-slate-500">Field Type</span>
                      <select
                        value={field.type}
                        onChange={(event) =>
                          onChange(field.id, { type: event.target.value as FieldType })
                        }
                        className="rounded border border-slate-300 px-2 py-1 text-sm capitalize focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
                      >
                        {TYPE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="text-xs uppercase text-slate-500">
                      Page <span className="font-semibold normal-case text-slate-700">{field.pageIndex + 1}</span>
                    </div>
                    {isText ? (
                      <div className="flex flex-col gap-2 border-t border-slate-200 pt-3">
                        <label className="flex flex-col gap-1 text-xs">
                          <span className="uppercase text-slate-500">Font</span>
                          <select
                            value={field.font}
                            onChange={(event) =>
                              handleFontChange(field, event.target.value as FieldFont)
                            }
                            className="rounded border border-slate-300 px-2 py-1 text-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
                          >
                            {AVAILABLE_FONTS.map((font) => (
                              <option key={font} value={font}>
                                {font}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="flex items-center justify-between gap-2 text-xs">
                          <span className="uppercase text-slate-500">Auto Size</span>
                          <input
                            type="checkbox"
                            checked={field.autoSize}
                            onChange={(event) =>
                              onChange(field.id, { autoSize: event.target.checked })
                            }
                            className="h-4 w-4"
                          />
                        </label>
                        {!field.autoSize ? (
                          <label className="flex flex-col gap-1 text-xs">
                            <span className="uppercase text-slate-500">Font Size</span>
                            <input
                              type="number"
                              min={4}
                              max={72}
                              value={field.fontSize}
                              onChange={(event) => handleFontSizeChange(field, event.target.value)}
                              className="rounded border border-slate-300 px-2 py-1 text-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
                            />
                          </label>
                        ) : null}
                      </div>
                    ) : null}
                    {isOptionType(field.type) ? (
                      <div className="flex flex-col gap-2 border-t border-slate-200 pt-3">
                        <label className="flex flex-col gap-1 text-xs">
                          <span className="uppercase text-slate-500">Options</span>
                          <textarea
                            value={field.options?.join(", ") ?? ""}
                            onChange={(event) =>
                              onChange(field.id, {
                                options: event.target.value.split(",").map((s) => s.trim()),
                              })
                            }
                            className="rounded border border-slate-300 px-2 py-1 text-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
                          />
                        </label>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};


function defaultNameForType(type: FieldType, existing: PdfField[]): string {
  const base =
    type === "text"
      ? "Text"
      : type === "multiline"
      ? "Multiline"
      : type === "checkbox"
      ? "Checkbox"
      : type === "signature"
      ? "Signature"
      : type === "radio"
      ? "Radio Group"
      : type === "dropdown"
      ? "Dropdown"
      : type === "listbox"
      ? "List Box"
      : "Button";
  const count = existing.filter((field) => field.type === type).length + 1;
  return `${base} ${count}`;
}

const ensureUniqueFieldName = (baseName: string, used: Set<string>) => {
  let candidate = baseName.trim() || "Field";
  let index = 1;
  while (used.has(candidate)) {
    candidate = `${baseName.trim() || "Field"} ${++index}`;
  }
  used.add(candidate);
  return candidate;
};

const fontByName = async (pdfDoc: PDFDocument, fontName: FieldFont): Promise<PDFFont> => {
  const standardFont =
    fontName === "Helvetica"
      ? StandardFonts.Helvetica
      : fontName === "Helvetica-Bold"
      ? StandardFonts.HelveticaBold
      : fontName === "Times-Roman"
      ? StandardFonts.TimesRoman
      : fontName === "Times-Bold"
      ? StandardFonts.TimesRomanBold
      : fontName === "Courier"
      ? StandardFonts.Courier
      : StandardFonts.CourierBold;
  return pdfDoc.embedStandardFont(standardFont);
};

const PdfEditor = () => {
  const pdfjsRef = useRef<PdfJsModule | null>(null);

  const [pdfBinary, setPdfBinary] = useState<Uint8Array | null>(null);
  const [pdfProxy, setPdfProxy] = useState<PDFDocumentProxy | null>(null);
  const [pageSizes, setPageSizes] = useState<PageMeasurement[]>([]);
  const [selectedTool, setSelectedTool] = useState<FieldType | null>(null);
  const [fields, setFields] = useState<PdfField[]>([]);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [recentlyDeletedField, setRecentlyDeletedField] = useState<PdfField | null>(null);
  const [fileName, setFileName] = useState<string>("edited-form");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const renderScale = 1.2;

  const clearRecentlyDeleted = () => {
    if (recentlyDeletedField) {
      setRecentlyDeletedField(null);
    }
  };

  const handleSelectField = (id: string | null) => {
    clearRecentlyDeleted();
    setSelectedFieldId(id);
  };

  useEffect(() => {
    if (!selectedFieldId) return;
    const field = fields.find((f) => f.id === selectedFieldId);
    if (!field) return;
    const pageNode = pageRefs.current[field.pageIndex];
    if (pageNode) {
      pageNode.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selectedFieldId, fields]);

  const ensurePdfJs = useCallback(async (): Promise<PdfJsModule> => {
    if (pdfjsRef.current) {
      return pdfjsRef.current;
    }
    const loadedModule = await loadPdfJs();
    pdfjsRef.current = loadedModule;
    if (typeof window !== "undefined") {
      loadedModule.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    }
    return loadedModule;
  }, []);

  useEffect(() => {
    ensurePdfJs().catch((initializationError) => {
      console.error("Failed to initialize pdf.js", initializationError);
      setError("Unable to initialize the PDF renderer. Please refresh and try again.");
    });
  }, [ensurePdfJs]);

  const handleFileChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    setIsLoading(true);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const binary = new Uint8Array(arrayBuffer);
      const binaryForExport = new Uint8Array(binary);
      const pdfjs = await ensurePdfJs();
      if (pdfProxy) {
        await pdfProxy.destroy();
      }
      const loadingTask = pdfjs.getDocument({ data: binary });
      const proxy = await loadingTask.promise;
      const sizes: PageMeasurement[] = [];
      for (let i = 1; i <= proxy.numPages; i += 1) {
        const page = await proxy.getPage(i);
        const viewport = page.getViewport({ scale: 1 });
        sizes.push({ width: viewport.width, height: viewport.height });
      }
      const existingFields = await mapExistingFields(binaryForExport, sizes);
      setPdfBinary(binaryForExport);
      setPdfProxy(proxy);
      setPageSizes(sizes);
      setFields(existingFields);
      setSelectedFieldId(existingFields[0]?.id ?? null);
      setFileName(file.name.replace(/\.pdf$/i, "") || "edited-form");
    } catch (uploadError) {
      console.error(uploadError);
      setError("Unable to open the selected PDF. Please try another file.");
    } finally {
      setIsLoading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }, [ensurePdfJs, pdfProxy]);

  const toggleTool = (tool: FieldType) => {
    setSelectedTool((current) => (current === tool ? null : tool));
  };

  const handleCreateField = useCallback(
    (pageIndex: number, rect: NormalizedRect) => {
      if (!selectedTool) return;
      clearRecentlyDeleted();
      const newField: PdfField = {
        id: uuid(),
        name: defaultNameForType(selectedTool, fields),
        type: selectedTool,
        pageIndex,
        rect,
        autoSize: true,
        font: "Helvetica",
        fontSize: 12,
      };
      setFields((prev) => [...prev, newField]);
      setSelectedFieldId(newField.id);
      setSelectedTool(null);
    },
    [fields, selectedTool]
  );

  const handleMoveField = useCallback((fieldId: string, rect: NormalizedRect) => {
    setFields((prev) =>
      prev.map((field) => (field.id === fieldId ? { ...field, rect } : field))
    );
  }, []);

  const handleUpdateField = (id: string, updates: Partial<PdfField>) => {
    clearRecentlyDeleted();

    const field = fields.find((f) => f.id === id);
    if (!field) return;

    if (field.type === "radio" && updates.type === "checkbox") {
      const newCheckboxes: PdfField[] = (field.widgetRects ?? []).map((rect, index) => ({
        id: uuid(),
        name: `${field.name} ${index + 1}`,
        type: "checkbox",
        pageIndex: field.pageIndex,
        rect,
        autoSize: true,
        font: "Helvetica",
        fontSize: 12,
      }));

      setFields((prev) => [...prev.filter((f) => f.id !== id), ...newCheckboxes]);
      setSelectedFieldId(newCheckboxes[0]?.id ?? null);
      return;
    }

    setFields((prev) =>
      prev.map((field) => {
        if (field.id !== id) return field;

        if (updates.type && updates.type !== field.type) {
          if (isTextType(updates.type) && isTextType(field.type)) {
            return { ...field, ...updates };
          }

          if (isTextType(updates.type)) {
            return {
              ...field,
              ...updates,
              type: updates.type,
              autoSize: field.autoSize ?? true,
              font: field.font ?? "Helvetica",
              fontSize: field.fontSize ?? 12,
            };
          }

          return {
            ...field,
            ...updates,
            type: updates.type,
            autoSize: true,
          };
        }

        return { ...field, ...updates };
      })
    );
  };

  const handleDeleteField = (id: string) => {
    const fieldToDelete = fields.find((field) => field.id === id);
    if (!fieldToDelete) return;
    setRecentlyDeletedField(fieldToDelete);
    setFields((prev) => prev.filter((field) => field.id !== id));
    setSelectedFieldId((current) => (current === id ? null : current));
  };

  const handleUndoDelete = () => {
    if (!recentlyDeletedField) return;
    setFields((prev) => [...prev, recentlyDeletedField]);
    setSelectedFieldId(recentlyDeletedField.id);
    setRecentlyDeletedField(null);
  };

  const handleExport = useCallback(async () => {
    if (!pdfBinary) {
      setError("Upload a PDF before exporting.");
      return;
    }
    setError(null);
    try {
      const pdfDoc = await PDFDocument.load(pdfBinary);
      const fontCache = new Map<FieldFont, PDFFont>();
      const form = pdfDoc.getForm();
      const pages = pdfDoc.getPages();
      const usedNames = new Set<string>();

      const context = pdfDoc.context;
      form.acroForm.dict.set(PDFName.of("Fields"), context.obj([]));
      pages.forEach((page) => {
        page.node.set(PDFName.of("Annots"), context.obj([]));
      });

      const appendSignatureField = (
        name: string,
        page: (typeof pages)[number],
        rect: { x: number; y: number; width: number; height: number }
      ) => {
        const partialName = name;
        const parent = (form.acroForm as unknown) as AcroParentNode;

        const signatureDict = pdfDoc.context.obj({
          FT: PDFName.of("Sig"),
          Kids: [],
        });
        const signatureRef = pdfDoc.context.register(signatureDict);
        const acroSignature = PDFAcroSignature.fromDict(signatureDict, signatureRef);
        acroSignature.setPartialName(partialName);

        const entries = parent.normalizedEntries();
        const siblingsSource = (entries?.Kids ?? entries?.Fields) as Parameters<typeof createPDFAcroFields>[0];
        const siblings = createPDFAcroFields(siblingsSource);
        for (const [existing] of siblings) {
          if (existing.getPartialName() === partialName) {
            throw new Error(`A field named ${name} already exists in the document.`);
          }
        }

        parent.addField(signatureRef);

        const widget = PDFWidgetAnnotation.create(pdfDoc.context, signatureRef);
        widget.setRectangle(rect);
        widget.setFlagTo(AnnotationFlags.Print, true);
        widget.setP(page.ref);
        const widgetRef = pdfDoc.context.register(widget.dict);
        acroSignature.addWidget(widgetRef);
        page.node.addAnnot(widgetRef);
      };

      for (const field of fields) {
        const page = pages[field.pageIndex];
        if (!page) continue;
        const { width, height } = page.getSize();
        const absolute = {
          x: field.rect.x * width,
          y: height - (field.rect.y + field.rect.height) * height,
          width: field.rect.width * width,
          height: field.rect.height * height,
        };

        const baseName = field.name?.trim() || defaultNameForType(field.type, fields);
        const name = ensureUniqueFieldName(baseName, usedNames);

        if (field.type === "text" || field.type === "multiline") {
          const textField = form.createTextField(name);
          textField.addToPage(page, absolute);
          if (field.type === "multiline") {
            textField.enableMultiline();
          } else {
            textField.disableMultiline();
          }
          if (!fontCache.has(field.font)) {
            const embedded = await fontByName(pdfDoc, field.font);
            fontCache.set(field.font, embedded);
          }
          const embeddedFont = fontCache.get(field.font)!;
          textField.updateAppearances(embeddedFont);
          if (!field.autoSize) {
            textField.setFontSize(field.fontSize);
          }
        } else if (field.type === "checkbox") {
          const checkbox = form.createCheckBox(name);
          checkbox.addToPage(page, absolute);
        } else if (field.type === "signature") {
          appendSignatureField(name, page, absolute);
        } else if (field.type === "dropdown") {
          const dropdown = form.createDropdown(name);
          dropdown.addOptions(field.options ?? []);
          dropdown.addToPage(page, absolute);
        } else if (field.type === "listbox") {
          const listbox = form.createOptionList(name);
          listbox.addOptions(field.options ?? []);
          listbox.addToPage(page, absolute);
        } else if (field.type === "button") {
          const button = form.createButton(name);
          button.addToPage(page, absolute);
        } else if (field.type === "radio") {
          console.warn("Exporting radio groups is not yet implemented.");
        }
      }

      const pdfBytes = await pdfDoc.save();
      const binary = new ArrayBuffer(pdfBytes.byteLength);
      new Uint8Array(binary).set(pdfBytes);
      const blob = new Blob([binary], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${fileName || "edited-form"}-with-fields.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      console.error(exportError);
      setError(
        "Something went wrong while embedding the fields. Please verify your fields and try again."
      );
    }
  }, [fields, fileName, pdfBinary]);

  const pageFieldMap = useMemo(() => {
    return pageSizes.map((_, index) => fields.filter((field) => field.pageIndex === index));
  }, [fields, pageSizes]);

  return (
    <div className="flex h-full w-full flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center gap-3">
          <label className="inline-flex items-center gap-2 rounded border border-dashed border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:border-slate-400">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              onChange={handleFileChange}
              className="hidden"
            />
            Upload PDF
          </label>
          {isLoading ? <span className="text-sm text-slate-500">Loading…</span> : null}
          {pdfProxy ? (
            <span className="text-sm text-slate-500">
              {pdfProxy.numPages} page{pdfProxy.numPages === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(Object.keys(TOOL_LABELS) as FieldType[]).map((tool) => (
            <button
              key={tool}
              type="button"
              onClick={() => toggleTool(tool)}
              className={`rounded px-3 py-2 text-sm font-medium transition ${
                selectedTool === tool
                  ? "bg-sky-600 text-white shadow"
                  : "bg-slate-100 text-slate-800 hover:bg-slate-200"
              }`}
            >
              {TOOL_LABELS[tool]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={fileName}
            onChange={(event) => setFileName(event.target.value)}
            placeholder="File name"
            className="w-40 rounded border border-slate-300 px-2 py-1 text-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
          />
          <button
            type="button"
            onClick={handleExport}
            disabled={!pdfProxy || fields.length === 0}
            className="rounded bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-emerald-200"
          >
            Export PDF
          </button>
        </div>
      </div>
      {error ? (
        <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-600">
          {error}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 gap-4">
        <div className="flex-1 overflow-auto rounded border border-slate-200 bg-slate-50 p-4">
          {!pdfProxy ? (
            <div className="flex h-full items-center justify-center text-center text-slate-500">
              Upload a PDF to begin adding form fields.
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              {pageSizes.map((size, index) => (
                <div key={index} ref={(el) => (pageRefs.current[index] = el)}>
                  <PdfPage
                    pdf={pdfProxy}
                    pageIndex={index}
                    renderScale={renderScale}
                    fields={pageFieldMap[index] ?? []}
                    selectedTool={selectedTool}
                    onCreateField={handleCreateField}
                    onSelectField={handleSelectField}
                    onMoveField={handleMoveField}
                    selectedFieldId={selectedFieldId}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="w-80 flex-shrink-0 rounded border border-slate-200 bg-white p-4 shadow-sm">
          <FieldList
            fields={fields}
            selectedFieldId={selectedFieldId}
            onSelect={handleSelectField}
            onChange={handleUpdateField}
            onDelete={handleDeleteField}
            recentlyDeleted={recentlyDeletedField}
            onUndoDelete={handleUndoDelete}
          />
        </div>
      </div>
    </div>
  );
};

export default PdfEditor;
