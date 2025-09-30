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
import { normalizeFieldNames } from "@/lib/normalize";
import { PDFFieldDetector } from "@/lib/pdfFieldDetection";
import { runDetectionTest } from "@/lib/detectionTest";
import type { FieldFont, FieldType, NormalizedRect, PdfField, TextElement, DetectedElement, FieldSuggestion } from "@/types/form";

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

// Field detection types are now imported from @/types/form

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

// Icon components for each field type
const getFieldIcon = (type: FieldType) => {
  const IconComponent = FieldIcons[type];
  return <IconComponent className="w-3 h-3" />;
};

const FieldIcons: Record<FieldType, React.FC<{ className?: string }>> = {
  text: ({ className = "w-4 h-4" }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M4 7V4h16v3M9 20h6M12 4v16" />
    </svg>
  ),
  multiline: ({ className = "w-4 h-4" }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M3 6h18M3 10h18M3 14h18M3 18h10" />
    </svg>
  ),
  checkbox: ({ className = "w-4 h-4" }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
  signature: ({ className = "w-4 h-4" }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="m14.5 3.5 6 6-11 11H3v-6.5l11-11Z" />
      <path d="M17 6.5 20.5 3l-3.5-3.5L13.5 3 17 6.5Z" />
    </svg>
  ),
  radio: ({ className = "w-4 h-4" }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="3" fill="currentColor" />
    </svg>
  ),
  dropdown: ({ className = "w-4 h-4" }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <rect x="3" y="4" width="18" height="16" rx="2" ry="2" />
      <path d="m7 10 5 5 5-5" />
    </svg>
  ),
  listbox: ({ className = "w-4 h-4" }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <rect x="3" y="4" width="18" height="16" rx="2" ry="2" />
      <path d="M7 8h10M7 12h10M7 16h4" />
    </svg>
  ),
  button: ({ className = "w-4 h-4" }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <rect x="3" y="6" width="18" height="12" rx="4" ry="4" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  ),
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

type ResizeState = {
  pageIndex: number;
  fieldId: string;
  pointerId: number;
  handle: 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w';
  initialRect: NormalizedRect;
  startPoint: { x: number; y: number };
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
  onResizeField: (fieldId: string, rect: NormalizedRect) => void;
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
  const normalizedWidth = clamp(rect.width / page.width, 0.01, 1);
  const normalizedHeight = clamp(rect.height / page.height, 0.01, 1);
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
  onResizeField,
  selectedFieldId,
}: PdfPageProps) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [renderDimensions, setRenderDimensions] = useState<PageMeasurement | null>(null);
  const pendingDrawRef = useRef<PendingDraw | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const resizeStateRef = useRef<ResizeState | null>(null);
  const [draftRect, setDraftRect] = useState<NormalizedRect | null>(null);

  // Resize handles component
  const ResizeHandles = ({ field }: { field: PdfField }) => {
    const handleResizeStart = (
      event: React.PointerEvent<HTMLDivElement>,
      handle: ResizeState['handle']
    ) => {
      event.stopPropagation();
      const point = normalizePoint(event);
      resizeStateRef.current = {
        pageIndex,
        fieldId: field.id,
        pointerId: event.pointerId,
        handle,
        initialRect: { ...field.rect },
        startPoint: point,
      };
      const container = containerRef.current;
      if (container) {
        container.setPointerCapture(event.pointerId);
      }
    };

    const handles = [
      { handle: 'nw' as const, cursor: 'nw-resize', position: 'top-0 left-0 -translate-x-1/2 -translate-y-1/2' },
      { handle: 'ne' as const, cursor: 'ne-resize', position: 'top-0 right-0 translate-x-1/2 -translate-y-1/2' },
      { handle: 'sw' as const, cursor: 'sw-resize', position: 'bottom-0 left-0 -translate-x-1/2 translate-y-1/2' },
      { handle: 'se' as const, cursor: 'se-resize', position: 'bottom-0 right-0 translate-x-1/2 translate-y-1/2' },
      { handle: 'n' as const, cursor: 'n-resize', position: 'top-0 left-1/2 -translate-x-1/2 -translate-y-1/2' },
      { handle: 's' as const, cursor: 's-resize', position: 'bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2' },
      { handle: 'e' as const, cursor: 'e-resize', position: 'top-1/2 right-0 translate-x-1/2 -translate-y-1/2' },
      { handle: 'w' as const, cursor: 'w-resize', position: 'top-1/2 left-0 -translate-x-1/2 -translate-y-1/2' },
    ];

    return (
      <>
        {handles.map(({ handle, cursor, position }) => (
          <div
            key={handle}
            className={`absolute w-2 h-2 bg-blue-600 border border-white rounded-sm ${position}`}
            style={{ cursor }}
            onPointerDown={(event) => handleResizeStart(event, handle)}
          />
        ))}
      </>
    );
  };

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
    if (width < 0.01 || height < 0.01) {
      return;
    }
    onCreateField(pageIndex, {
      x: clamp(x, 0, 1),
      y: clamp(y, 0, 1),
      width: clamp(width, 0.01, 1),
      height: clamp(height, 0.01, 1),
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
    const resizeState = resizeStateRef.current;
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
      return;
    }

    if (resizeState) {
      const point = normalizePoint(event);
      const { initialRect, startPoint, handle } = resizeState;
      const deltaX = point.x - startPoint.x;
      const deltaY = point.y - startPoint.y;
      
      const newRect = { ...initialRect };
      
      // Handle different resize directions
      if (handle.includes('n')) { // north
        newRect.y = initialRect.y + deltaY;
        newRect.height = initialRect.height - deltaY;
      }
      if (handle.includes('s')) { // south
        newRect.height = initialRect.height + deltaY;
      }
      if (handle.includes('w')) { // west
        newRect.x = initialRect.x + deltaX;
        newRect.width = initialRect.width - deltaX;
      }
      if (handle.includes('e')) { // east
        newRect.width = initialRect.width + deltaX;
      }
      
      // Ensure minimum size and bounds
      const minSize = 0.01;
      newRect.width = Math.max(minSize, newRect.width);
      newRect.height = Math.max(minSize, newRect.height);
      newRect.x = clamp(newRect.x, 0, 1 - newRect.width);
      newRect.y = clamp(newRect.y, 0, 1 - newRect.height);
      
      onResizeField(resizeState.fieldId, newRect);
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

    if (resizeStateRef.current) {
      resizeStateRef.current = null;
    }

    if (pendingDrawRef.current) {
      finalizeDraw();
    }
  };

  useEffect(() => {
    const handlePointerMoveWindow = (event: PointerEvent) => {
      const pending = pendingDrawRef.current;
      const dragState = dragStateRef.current;
      const resizeState = resizeStateRef.current;
      if (!pending && !dragState && !resizeState) return;
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
      } else if (resizeState) {
        const { initialRect, startPoint, handle } = resizeState;
        const deltaX = point.x - startPoint.x;
        const deltaY = point.y - startPoint.y;
        
        const newRect = { ...initialRect };
        
        if (handle.includes('n')) {
          newRect.y = initialRect.y + deltaY;
          newRect.height = initialRect.height - deltaY;
        }
        if (handle.includes('s')) {
          newRect.height = initialRect.height + deltaY;
        }
        if (handle.includes('w')) {
          newRect.x = initialRect.x + deltaX;
          newRect.width = initialRect.width - deltaX;
        }
        if (handle.includes('e')) {
          newRect.width = initialRect.width + deltaX;
        }
        
        const minSize = 0.01;
        newRect.width = Math.max(minSize, newRect.width);
        newRect.height = Math.max(minSize, newRect.height);
        newRect.x = clamp(newRect.x, 0, 1 - newRect.width);
        newRect.y = clamp(newRect.y, 0, 1 - newRect.height);
        
        onResizeField(resizeState.fieldId, newRect);
      }
    };

    const handlePointerUpWindow = () => {
      if (pendingDrawRef.current) {
        finalizeDraw();
      }
      dragStateRef.current = null;
      resizeStateRef.current = null;
      pendingDrawRef.current = null;
      setDraftRect(null);
    };

    window.addEventListener("pointermove", handlePointerMoveWindow);
    window.addEventListener("pointerup", handlePointerUpWindow);
    return () => {
      window.removeEventListener("pointermove", handlePointerMoveWindow);
      window.removeEventListener("pointerup", handlePointerUpWindow);
    };
  }, [fields, finalizeDraw, normalizePoint, onMoveField, onResizeField, updateDraftRect]);

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
            {renderDimensions && (
              <span 
                className="absolute left-1 top-1 bg-slate-800/80 text-white text-xs px-1 py-px rounded flex items-center gap-1 max-w-full overflow-hidden whitespace-nowrap"
                style={{
                  fontSize: field.rect.width * renderDimensions.width < 60 ? '10px' : '12px',
                  display: field.rect.width * renderDimensions.width < 30 || field.rect.height * renderDimensions.height < 20 ? 'none' : 'flex'
                }}
              >
                {field.type === 'signature' && field.rect.width * renderDimensions.width >= 50 && (
                  <FieldIcons.signature className="w-3 h-3 flex-shrink-0" />
                )}
                <span className="truncate">
                  {field.rect.width * renderDimensions.width < 80 ? field.name.slice(0, 8) + (field.name.length > 8 ? '...' : '') : field.name}
                </span>
              </span>
            )}
            {selectedFieldId === field.id && <ResizeHandles field={field} />}
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
                ref={(el) => { itemRefs.current[field.id] = el; }}
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

// PDF Content Analysis Functions
const extractTextFromPage = async (pdf: PDFDocumentProxy, pageIndex: number): Promise<TextElement[]> => {
  try {
    const page = await pdf.getPage(pageIndex + 1);
    const textContent = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });
    
    // Extract individual text items with detailed positioning
    const textItems: Array<{text: string; x: number; y: number; width: number; height: number; fontSize: number; transform: number[]}> = [];
    textContent.items.forEach((item) => {
      if (item && 'str' in item && item.str && item.str.trim() && 'transform' in item) {
        const transform = item.transform;
        const x = transform[4];
        const y = viewport.height - transform[5]; // Flip Y coordinate for standard coordinates
        const fontSize = Math.abs(transform[3]) || 12;
        
        // Calculate approximate width based on character count and font size
        const charWidth = fontSize * 0.6; // Approximate character width
        const width = item.str.length * charWidth;
        
        textItems.push({
          text: item.str.trim(),
          x: x,
          y: y,
          width: width,
          height: fontSize,
          fontSize: fontSize,
          transform: transform
        });
      }
    });
    
    // Group text items into logical text boxes (similar to pdfminer's approach)
    const textboxes = groupTextIntoLines(textItems);
    
    // Convert to normalized coordinates for consistency
    return textboxes.map(box => ({
      text: box.text,
      rect: {
        x: box.x / viewport.width,
        y: box.y / viewport.height,
        width: box.width / viewport.width,
        height: box.height / viewport.height
      },
      fontSize: box.fontSize
    }));
    
  } catch (error) {
    console.warn('Failed to extract text from page:', error);
    return [];
  }
};

// Group individual text items into coherent text lines/boxes
const groupTextIntoLines = (textItems: Array<{text: string; x: number; y: number; width: number; height: number; fontSize: number; transform: number[]}>) => {
  if (textItems.length === 0) return [];
  
  // Sort by Y position (top to bottom), then X position (left to right)
  textItems.sort((a, b) => {
    const yDiff = Math.abs(a.y - b.y);
    if (yDiff < 3) { // Same line threshold
      return a.x - b.x;
    }
    return b.y - a.y; // Higher Y first (top to bottom)
  });
  
  const textboxes: Array<{text: string; x: number; y: number; width: number; height: number; fontSize: number; items: typeof textItems}> = [];
  let currentLine: {text: string; x: number; y: number; width: number; height: number; fontSize: number; items: typeof textItems} | null = null;
  
  for (const item of textItems) {
    if (!currentLine) {
      // Start first line
      currentLine = {
        text: item.text,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        fontSize: item.fontSize,
        items: [item]
      };
    } else {
      const yThreshold = Math.max(currentLine.fontSize * 0.4, 3);
      const xGap = item.x - (currentLine.x + currentLine.width);
      const maxGap = Math.max(currentLine.fontSize * 1.0, 10);
      
      const isOnSameLine = Math.abs(item.y - currentLine.y) <= yThreshold;
      const isReasonablyClose = xGap <= maxGap;
      
      if (isOnSameLine && isReasonablyClose) {
        // Add to current line
        const gap = Math.max(0, xGap);
        currentLine.text += (gap > 2 ? ' ' : '') + item.text;
        currentLine.width = item.x + item.width - currentLine.x;
        currentLine.height = Math.max(currentLine.height, item.height);
        currentLine.items.push(item);
      } else {
        // Finish current line and start new one
        textboxes.push(currentLine);
        currentLine = {
          text: item.text,
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height,
          fontSize: item.fontSize,
          items: [item]
        };
      }
    }
  }
  
  if (currentLine) {
    textboxes.push(currentLine);
  }
  
  // Filter out very short or meaningless text
  return textboxes.filter(box => 
    box.text.trim().length > 0 && 
    !box.text.match(/^[_\s\.\-]{1,3}$/) // Filter out underscores, dots, dashes only
  );
};

const detectVisualElements = async (pdf: PDFDocumentProxy, pageIndex: number, textElements?: TextElement[]): Promise<DetectedElement[]> => {
  try {
    const page = await pdf.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1 });
    
    // Create high-resolution canvas for better line detection (similar to Python DPI approach)
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return [];
    
    const scale = 3; // Higher resolution for better line detection
    canvas.width = viewport.width * scale;
    canvas.height = viewport.height * scale;
    
    const scaledViewport = page.getViewport({ scale });
    
    // Render the page to canvas
    await page.render({
      canvasContext: context,
      canvas: canvas,
      viewport: scaledViewport
    }).promise;
    
    // Get image data for analysis
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    
    // Use the new sophisticated detection system
    const detector = new PDFFieldDetector({
      minTextFieldHeight: Math.max(12, canvas.height * 0.015), // Minimum 10pt text height
      maxFieldHeight: canvas.height * 0.5, // Maximum 1/2 page height
      minCheckboxSize: Math.max(8, canvas.width * 0.008),
      maxCheckboxSize: Math.min(20, canvas.width * 0.025),
      minRadioSize: Math.max(8, canvas.width * 0.008),
      maxRadioSize: Math.min(16, canvas.width * 0.02),
      mergeThreshold: Math.max(3, canvas.width * 0.005),
      confidenceThreshold: 0.25 // Reduced threshold to be less conservative
    });
    
    const allElements = detector.detectFields(imageData, canvas.width, canvas.height, textElements);
    
    // Convert back to normalized coordinates relative to original viewport
    return allElements.map(element => ({
      ...element,
      rect: {
        x: element.rect.x / (viewport.width * scale),
        y: element.rect.y / (viewport.height * scale),
        width: element.rect.width / (viewport.width * scale),  
        height: element.rect.height / (viewport.height * scale)
      }
    }));
    
  } catch (error) {
    console.warn('Failed to detect visual elements:', error);
    return [];
  }
};

// Simplified text field detection to prevent UI blocking
const PdfEditor = () => {
  const pdfjsRef = useRef<PdfJsModule | null>(null);

  const [pdfBinary, setPdfBinary] = useState<Uint8Array | null>(null);
  const [pdfProxy, setPdfProxy] = useState<PDFDocumentProxy | null>(null);
  const [pageSizes, setPageSizes] = useState<PageMeasurement[]>([]);
  const [selectedTool, setSelectedTool] = useState<FieldType | null>(null);
  const [fields, setFields] = useState<PdfField[]>([]);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [recentlyDeletedField, setRecentlyDeletedField] = useState<PdfField | null>(null);
  const [previousFields, setPreviousFields] = useState<PdfField[] | null>(null);
  const [fileName, setFileName] = useState<string>("edited-form");
  const [isLoading, setIsLoading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldSuggestions, setFieldSuggestions] = useState<FieldSuggestion[]>([]);
  const [isAutoDetecting, setIsAutoDetecting] = useState(false);
  const [detectionProgress, setDetectionProgress] = useState({ current: 0, total: 0 });
  const [showSuggestions, setShowSuggestions] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const renderScale = 1.2;

  const ensurePdfJs = useCallback(async (): Promise<PdfJsModule> => {
    if (pdfjsRef.current) {
      return pdfjsRef.current;
    }
    const loadedModule = await loadPdfJs();
    pdfjsRef.current = loadedModule;
    if (typeof window !== "undefined") {
      // Use dynamic path based on environment
      const basePath = process.env.NODE_ENV === 'production' && process.env.GITHUB_ACTIONS === 'true' 
        ? '/pdf-editor-ui' 
        : '';
      loadedModule.GlobalWorkerOptions.workerSrc = `${basePath}/pdf.worker.min.mjs`;
    }
    return loadedModule;
  }, []);

  useEffect(() => {
    ensurePdfJs().catch((initializationError) => {
      console.error("Failed to initialize pdf.js", initializationError);
      setError("Unable to initialize the PDF renderer. Please refresh and try again.");
    });
  }, [ensurePdfJs]);

  const processFile = useCallback(async (file: File) => {
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
    }
  }, [ensurePdfJs, pdfProxy]);

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleDrop = useCallback(async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);

    const files = event.dataTransfer.files;
    if (files && files.length > 0) {
      const file = files[0];
      if (file && file.type === 'application/pdf') {
        await processFile(file);
      }
    }
  }, [processFile]);

  const clearRecentlyDeleted = useCallback(() => {
    if (recentlyDeletedField) {
      setRecentlyDeletedField(null);
    }
  }, [recentlyDeletedField]);

  const handleSelectField = (id: string | null) => {
    clearRecentlyDeleted();
    setSelectedFieldId(id);
  };

  const handleNormalizeNames = () => {
    setPreviousFields(fields);
    setFields(normalizeFieldNames(fields));
  };

  const handleUndoNormalize = () => {
    if (previousFields) {
      setFields(previousFields);
      setPreviousFields(null);
    }
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

  // Add testing functionality to window for console access
  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as any).testPDFDetection = async (labeledPdfUrl: string, unlabeledPdfUrl: string) => {
        try {
          console.log('Loading test PDFs...');
          
          // This would need to be implemented to load and compare PDFs
          // For now, just log the intent
          console.log(`Would test detection between:
            - Labeled: ${labeledPdfUrl}
            - Unlabeled: ${unlabeledPdfUrl}`);
          
          console.log('Test functionality available. Use: window.testPDFDetection("labeled.pdf", "unlabeled.pdf")');
        } catch (error) {
          console.error('Test failed:', error);
        }
      };

      // Log available test functions
      console.log('PDF Detection testing available via: window.testPDFDetection(labeledUrl, unlabeledUrl)');
    }
  }, []);

  const handleFileChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    await processFile(file);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, [processFile]);

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

      if (isTextType(selectedTool)) {
        newField.autoSize = false;
        newField.fontSize = 10;
      } else if (selectedTool === "radio") {
        newField.options = ["Option 1", "Option 2"];
        const optionHeight = rect.height / 2;
        newField.widgetRects = [
          { ...rect, height: optionHeight },
          { ...rect, y: rect.y + optionHeight, height: optionHeight },
        ];
      }

      setFields((prev) => [...prev, newField]);
      setSelectedFieldId(newField.id);
      setSelectedTool(null);
    },
    [fields, selectedTool, clearRecentlyDeleted]
  );

  const handleMoveField = useCallback((fieldId: string, rect: NormalizedRect) => {
    setFields((prev) =>
      prev.map((field) => (field.id === fieldId ? { ...field, rect } : field))
    );
  }, []);

  const handleResizeField = useCallback((fieldId: string, rect: NormalizedRect) => {
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

  const handleAutoDetectFields = useCallback(async () => {
    if (!pdfProxy) return;
    
    setIsAutoDetecting(true);
    setError(null);
    setFieldSuggestions([]); // Clear existing suggestions
    
    try {
      const allSuggestions: FieldSuggestion[] = [];
      const totalPages = pdfProxy.numPages;
      
      // Initialize progress
      setDetectionProgress({ current: 0, total: totalPages });
      
      // Process pages one by one with progress updates and yielding control
      for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
        // Update progress indication
        setDetectionProgress({ current: pageIndex + 1, total: totalPages });
        console.log(`Processing page ${pageIndex + 1} of ${totalPages}...`);
        
        // Yield control to the UI thread before processing each page
        await new Promise(resolve => setTimeout(resolve, 0));
        
        try {
          // Process text extraction first
          const textElements = await extractTextFromPage(pdfProxy, pageIndex);
          
          // Yield control again before heavy visual processing
          await new Promise(resolve => setTimeout(resolve, 10));
          
          // Process visual detection with timeout to prevent hanging
          const detectedElements = await Promise.race([
            detectVisualElements(pdfProxy, pageIndex, textElements),
            new Promise<DetectedElement[]>((_, reject) => 
              setTimeout(() => reject(new Error('Visual detection timeout')), 30000)
            )
          ]);
          
          // Generate suggestions from detected elements
          const pageSuggestions = detectedElements.map((element, index) => {
            // Simple field name generation
            const suggestedName = `field_${allSuggestions.length + index + 1}`;
            const suggestedType: FieldType = element.type === 'text' ? 'text' : 
                                           element.type === 'checkbox' ? 'checkbox' :
                                           element.type === 'radio' ? 'radio' :
                                           element.type === 'signature' ? 'signature' : 'text';
            
            return {
              element,
              suggestedName,
              suggestedType,
              nearbyText: [],
              confidence: element.confidence,
              pageIndex,
              name: suggestedName,
              type: suggestedType,
              x: element.rect.x,
              y: element.rect.y,
              width: element.rect.width,
              height: element.rect.height
            };
          });
          
          allSuggestions.push(...pageSuggestions);
          
          // Update intermediate results so user sees progress
          if (pageSuggestions.length > 0) {
            const currentSuggestions = allSuggestions.filter(s => s.confidence > 0.4);
            setFieldSuggestions([...currentSuggestions]);
            setShowSuggestions(true);
          }
          
        } catch (pageError) {
          console.warn(`Error processing page ${pageIndex + 1}:`, pageError);
          // Continue with other pages even if one fails
        }
      }
      
      // Final filtering and sorting
      const highConfidenceSuggestions = allSuggestions
        .filter(s => s.confidence > 0.4)
        .sort((a, b) => b.confidence - a.confidence);
      
      setFieldSuggestions(highConfidenceSuggestions);
      setShowSuggestions(true);
      
    } catch (autoDetectError) {
      console.error('Auto-detection failed:', autoDetectError);
      setError('Failed to auto-detect fields. Please try manual field creation.');
    } finally {
      setIsAutoDetecting(false);
    }
  }, [pdfProxy]);

  const handleAcceptSuggestion = useCallback((suggestion: FieldSuggestion) => {
    const newField: PdfField = {
      id: uuid(),
      name: suggestion.suggestedName,
      type: suggestion.suggestedType,
      pageIndex: suggestion.pageIndex || 0,
      rect: {
        x: suggestion.element.rect.x,
        y: suggestion.element.rect.y,
        width: suggestion.element.rect.width,
        height: suggestion.element.rect.height
      },
      autoSize: true,
      font: "Helvetica",
      fontSize: 12,
    };

    setFields(prev => [...prev, newField]);
    setFieldSuggestions(prev => prev.filter(s => s !== suggestion));
  }, []);

  const handleAcceptAllSuggestions = useCallback(() => {
    const newFields: PdfField[] = fieldSuggestions.map(suggestion => ({
      id: uuid(),
      name: suggestion.suggestedName,
      type: suggestion.suggestedType,
      pageIndex: suggestion.pageIndex || 0,
      rect: {
        x: suggestion.element.rect.x,
        y: suggestion.element.rect.y,
        width: suggestion.element.rect.width,
        height: suggestion.element.rect.height
      },
      autoSize: true,
      font: "Helvetica",
      fontSize: 12,
    }));

    setFields(prev => [...prev, ...newFields]);
    setFieldSuggestions([]);
    setShowSuggestions(false);
  }, [fieldSuggestions]);

  const handleRejectAllSuggestions = useCallback(() => {
    setFieldSuggestions([]);
    setShowSuggestions(false);
  }, []);

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
        // Remove border and background styling
        widget.dict.delete(PDFName.of('BS'));
        widget.dict.delete(PDFName.of('Border'));
        widget.dict.delete(PDFName.of('BG'));
        widget.dict.delete(PDFName.of('BC'));
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
          // Remove border and background styling
          textField.acroField.getWidgets().forEach(widget => {
            // Remove border style
            widget.dict.delete(PDFName.of('BS'));
            widget.dict.delete(PDFName.of('Border'));
            // Remove background color
            widget.dict.delete(PDFName.of('BG'));
            // Remove border color
            widget.dict.delete(PDFName.of('BC'));
          });
        } else if (field.type === "checkbox") {
          const checkbox = form.createCheckBox(name);
          checkbox.addToPage(page, absolute);
          // Remove border and background styling
          checkbox.acroField.getWidgets().forEach(widget => {
            // Remove border style
            widget.dict.delete(PDFName.of('BS'));
            widget.dict.delete(PDFName.of('Border'));
            // Remove background color
            widget.dict.delete(PDFName.of('BG'));
            // Remove border color
            widget.dict.delete(PDFName.of('BC'));
          });
        } else if (field.type === "signature") {
          appendSignatureField(name, page, absolute);
        } else if (field.type === "dropdown") {
          const dropdown = form.createDropdown(name);
          dropdown.addOptions(field.options ?? []);
          dropdown.addToPage(page, absolute);
          // Remove border and background styling
          dropdown.acroField.getWidgets().forEach(widget => {
            widget.dict.delete(PDFName.of('BS'));
            widget.dict.delete(PDFName.of('Border'));
            widget.dict.delete(PDFName.of('BG'));
            widget.dict.delete(PDFName.of('BC'));
          });
        } else if (field.type === "listbox") {
          const listbox = form.createOptionList(name);
          listbox.addOptions(field.options ?? []);
          listbox.addToPage(page, absolute);
          // Remove border and background styling
          listbox.acroField.getWidgets().forEach(widget => {
            widget.dict.delete(PDFName.of('BS'));
            widget.dict.delete(PDFName.of('Border'));
            widget.dict.delete(PDFName.of('BG'));
            widget.dict.delete(PDFName.of('BC'));
          });
        } else if (field.type === "button") {
          const button = form.createButton(name);
          // TypeScript workaround for pdf-lib button API
          (button as { addToPage: (page: unknown, rect: unknown) => void }).addToPage(page, absolute);
          // Remove border and background styling
          button.acroField.getWidgets().forEach(widget => {
            widget.dict.delete(PDFName.of('BS'));
            widget.dict.delete(PDFName.of('Border'));
            widget.dict.delete(PDFName.of('BG'));
            widget.dict.delete(PDFName.of('BC'));
          });
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
          {pdfProxy && (
            <button
              type="button"
              onClick={handleAutoDetectFields}
              disabled={isAutoDetecting}
              className="inline-flex items-center gap-2 rounded border border-emerald-300 px-3 py-2 text-sm font-medium text-emerald-700 hover:border-emerald-400 hover:bg-emerald-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isAutoDetecting ? (
                <>
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path d="M21 12a9 9 0 11-6.219-8.56"/>
                  </svg>
                  {detectionProgress.total > 0 ? 
                    `Processing ${detectionProgress.current}/${detectionProgress.total}...` : 
                    'Detecting...'
                  }
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <circle cx="11" cy="11" r="8"/>
                    <path d="m21 21-4.35-4.35"/>
                  </svg>
                  Auto-Detect Fields
                </>
              )}
            </button>
          )}
        </div>

        {fieldSuggestions.length > 0 && showSuggestions && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-blue-900">
                Found {fieldSuggestions.length} potential field{fieldSuggestions.length === 1 ? '' : 's'}
              </h3>
              <button
                type="button"
                onClick={() => setShowSuggestions(false)}
                className="text-blue-500 hover:text-blue-700"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>
            <div className="space-y-2 max-h-40 overflow-y-auto">
              {fieldSuggestions.map((suggestion, index) => (
                <div key={index} className="flex items-center justify-between bg-white p-2 rounded border">
                  <div className="flex items-center gap-2">
                    <div className="flex items-center justify-center w-6 h-6 bg-slate-100 rounded text-xs">
                      {getFieldIcon(suggestion.type)}
                    </div>
                    <div>
                      <span className="text-sm font-medium">{suggestion.name}</span>
                      <span className="text-xs text-slate-500 ml-2">
                        ({suggestion.type} at {Math.round(suggestion.x)}, {Math.round(suggestion.y)})
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleAcceptSuggestion(suggestion)}
                    className="text-xs bg-green-600 text-white px-2 py-1 rounded hover:bg-green-700"
                  >
                    Add Field
                  </button>
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-3">
              <button
                type="button"
                onClick={() => {
                  fieldSuggestions.forEach(handleAcceptSuggestion);
                  setFieldSuggestions([]);
                  setShowSuggestions(false);
                }}
                className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700"
              >
                Add All Fields
              </button>
              <button
                type="button"
                onClick={() => {
                  setFieldSuggestions([]);
                  setShowSuggestions(false);
                }}
                className="text-xs bg-slate-600 text-white px-3 py-1.5 rounded hover:bg-slate-700"
              >
                Dismiss All
              </button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {(Object.keys(TOOL_LABELS) as FieldType[]).map((tool) => {
            const IconComponent = FieldIcons[tool];
            return (
              <button
                key={tool}
                type="button"
                onClick={() => toggleTool(tool)}
                className={`flex items-center gap-2 rounded px-3 py-2 text-sm font-medium transition ${
                  selectedTool === tool
                    ? "bg-sky-600 text-white shadow"
                    : "bg-slate-100 text-slate-800 hover:bg-slate-200"
                }`}
              >
                <IconComponent className="w-4 h-4" />
                {TOOL_LABELS[tool]}
              </button>
            );
          })}
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
            onClick={handleNormalizeNames}
            className="rounded bg-slate-200 px-4 py-2 text-sm font-semibold text-slate-800 transition hover:bg-slate-300 disabled:cursor-not-allowed disabled:bg-slate-100"
          >
            Normalize Names
          </button>
          {previousFields ? (
            <button
              type="button"
              onClick={handleUndoNormalize}
              className="rounded bg-amber-100 px-4 py-2 text-sm font-semibold text-amber-800 transition hover:bg-amber-200"
            >
              Undo Normalize
            </button>
          ) : null}
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
        <div
          className={`flex-1 overflow-auto rounded border-2 bg-slate-50 p-4 ${
            isDragging ? "border-dashed border-sky-500" : "border-slate-200"
          }`}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          {!pdfProxy ? (
            <div className="flex h-full items-center justify-center text-center text-slate-500">
              <div>
                <p>Upload a PDF to begin adding form fields.</p>
                <p className="mt-2 text-sm">Or drag and drop a PDF here.</p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              {pageSizes.map((size, index) => (
                <div key={index} ref={(el) => { pageRefs.current[index] = el; }}>
                  <PdfPage
                    pdf={pdfProxy}
                    pageIndex={index}
                    renderScale={renderScale}
                    fields={pageFieldMap[index] ?? []}
                    selectedTool={selectedTool}
                    onCreateField={handleCreateField}
                    onSelectField={handleSelectField}
                    onMoveField={handleMoveField}
                    onResizeField={handleResizeField}
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
