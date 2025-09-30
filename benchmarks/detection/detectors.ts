import { promises as fs } from "fs";
import { createRequire } from "module";
import path from "path";
import { pathToFileURL } from "url";

import type { DatasetSample, DetectionOutput, PagePrediction } from "./types";
import type { FieldType, NormalizedRect } from "../../src/types/form";
import { PDFFieldDetector } from "../../src/lib/detectors/rasterHeuristics";

const require = createRequire(import.meta.url);

interface ModuleState<T = unknown> {
  module: T | null;
  error: Error | null;
}

let pdfjsState: ModuleState | null = null;
let pdfjsPromise: Promise<ModuleState> | null = null;
let canvasState: ModuleState | null = null;

const ensurePdfjs = async (): Promise<ModuleState> => {
  if (pdfjsState) {
    return pdfjsState;
  }

  if (pdfjsPromise) {
    return pdfjsPromise;
  }

  pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs")
    .then((module) => {
      if ((module as { GlobalWorkerOptions?: { disableWorker?: boolean } }).GlobalWorkerOptions) {
        const workerOptions = (module as {
          GlobalWorkerOptions: {
            disableWorker?: boolean;
            standardFontDataUrl?: string;
          };
        }).GlobalWorkerOptions;

        workerOptions.disableWorker = true;
        if (!workerOptions.standardFontDataUrl) {
          const pkgDir = path.dirname(require.resolve("pdfjs-dist/package.json"));
          const standardFontUrl = `${pathToFileURL(path.join(pkgDir, "standard_fonts")).href}/`;
          workerOptions.standardFontDataUrl = standardFontUrl;
        }
      }
      pdfjsState = { module, error: null };
      return pdfjsState;
    })
    .catch((error) => {
      const state: ModuleState = { module: null, error: error as Error };
      pdfjsState = state;
      return state;
    });

  return pdfjsPromise;
};

const ensureCanvas = (): ModuleState => {
  if (canvasState) {
    return canvasState;
  }

  try {
    const module = require("canvas");
    canvasState = { module, error: null };
  } catch (error) {
    canvasState = { module: null, error: error as Error };
  }

  return canvasState;
};

export interface DetectorContext {
  sample: DatasetSample;
  /** Root directory for PDF fixtures */
  datasetRoot: string;
  /** Optional configuration gathered from CLI flags */
  options?: Record<string, unknown>;
}

export interface Detector {
  name: string;
  description: string;
  detect(context: DetectorContext): Promise<DetectionOutput>;
}

const registry = new Map<string, Detector>();

export const registerDetector = (id: string, detector: Detector): void => {
  if (registry.has(id)) {
    throw new Error(`Detector ${id} is already registered`);
  }
  registry.set(id, detector);
};

export const getDetector = (id: string): Detector | undefined => registry.get(id);

export const listDetectors = (): Array<{ id: string; name: string; description: string }> => {
  return Array.from(registry.entries()).map(([id, detector]) => ({
    id,
    name: detector.name,
    description: detector.description,
  }));
};

export const requireDetector = (id: string): Detector => {
  const detector = getDetector(id);
  if (!detector) {
    throw new Error(`Unknown detector: ${id}`);
  }
  return detector;
};

// --- Built-in placeholders -------------------------------------------------

registerDetector("empty", {
  name: "Empty baseline",
  description: "Returns no detections; useful as a lower-bound sanity check.",
  async detect(context: DetectorContext): Promise<DetectionOutput> {
    const pages: PagePrediction[] = [];
    const annotations = context.sample.annotations;

    if (annotations) {
      for (const page of annotations.pages) {
        pages.push({ pageIndex: page.pageIndex, fields: [] });
      }
    }

    return {
      documentId: context.sample.documentId,
      pages,
      summary: { note: "No detections produced." },
    };
  },
});

// --- Heuristic detector ----------------------------------------------------

type SupportedDetectedType = "text" | "checkbox" | "radio" | "signature";

const TYPE_MAPPING: Record<SupportedDetectedType, FieldType> = {
  text: "text",
  checkbox: "checkbox",
  radio: "radio",
  signature: "signature",
};

const SCALE = 3;

const normalizeRect = (
  rect: { x: number; y: number; width: number; height: number },
  viewportWidth: number,
  viewportHeight: number
): NormalizedRect => {
  const safeWidth = viewportWidth === 0 ? 1 : viewportWidth;
  const safeHeight = viewportHeight === 0 ? 1 : viewportHeight;
  return {
    x: rect.x / safeWidth,
    y: rect.y / safeHeight,
    width: rect.width / safeWidth,
    height: rect.height / safeHeight,
  };
};

const detectorInstance = new PDFFieldDetector();

registerDetector("heuristic:pdfjs", {
  name: "Raster heuristics (pdf.js)",
  description: "Runs the client-side raster heuristics headlessly via pdf.js and node-canvas.",
  async detect(context: DetectorContext): Promise<DetectionOutput> {
    const { module: pdfjsLib, error: pdfError } = await ensurePdfjs();
    const { module: canvasLib, error: canvasError } = ensureCanvas();

    if (!pdfjsLib || !canvasLib) {
      const blockers: string[] = [];
      if (pdfError) blockers.push(`pdfjs-dist: ${pdfError.message}`);
      if (canvasError) blockers.push(`canvas: ${canvasError.message}`);

      return {
        documentId: context.sample.documentId,
        pages: [],
        summary: {
          detector: "heuristic:pdfjs",
          blocked: blockers,
          note: "Headless raster heuristics require optional native dependencies (pdfjs-dist + canvas).",
        },
      };
    }

    const { createCanvas } = canvasLib as { createCanvas: (width: number, height: number) => { getContext(type: string): CanvasRenderingContext2D | null; width: number; height: number } };

    const data = await fs.readFile(context.sample.pdfPath);
    const pdfData = new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength);
    const loadingTask = (pdfjsLib as { getDocument: (options: unknown) => { promise: Promise<unknown> } }).getDocument({ data: pdfData });
    const doc = (await loadingTask.promise) as {
      numPages: number;
      getPage(index: number): Promise<{ getViewport(options: { scale: number }): { width: number; height: number }; render(props: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }): { promise: Promise<void> } }>;
      destroy(): Promise<void>;
    };
    const pages: PagePrediction[] = [];

    try {
      for (let pageIndex = 0; pageIndex < doc.numPages; pageIndex += 1) {
        const page = await doc.getPage(pageIndex + 1);
        const viewport = page.getViewport({ scale: SCALE });

        const canvas = createCanvas(viewport.width, viewport.height);
        const context2d = canvas.getContext("2d");

        if (!context2d) {
          throw new Error("Failed to obtain 2D context from node-canvas");
        }

        await page.render({ canvasContext: context2d, viewport }).promise;

        const imageData = context2d.getImageData(0, 0, canvas.width, canvas.height) as ImageData;
        const width = canvas.width;
        const height = canvas.height;

        const rawDetections = detectorInstance.detectFields(imageData, width, height);

        const fields = rawDetections
          .map((element) => {
            if (!(element.type in TYPE_MAPPING)) {
              return null;
            }

            const normalized = normalizeRect(element.rect, width, height);

            return {
              type: TYPE_MAPPING[element.type as SupportedDetectedType],
              rect: normalized,
              confidence: element.confidence,
              attributes: { detectorSourceType: element.type },
            };
          })
          .filter(Boolean);

        pages.push({
          pageIndex,
          fields: fields as PagePrediction["fields"],
        });
      }
    } finally {
      await doc.destroy();
    }

    return {
      documentId: context.sample.documentId,
      pages,
      summary: { detector: "heuristic:pdfjs", scale: SCALE },
    };
  },
});

// --- Text layout heuristics (pdf.js) ---------------------------------------

const CHECKBOX_TOKENS = new Set(["[ ]", "[]", "( )", "□", "☐", "⚪", "○"]);
const CHECKBOX_PATTERN = /\[( |x)?\]|\( \)|[□☐⚪○]/u;
const LEADER_FRAGMENT_REGEX = /[_\.·•‧\-]{3,}/u;

const normalizeRectTopLeft = (
  x: number,
  y: number,
  width: number,
  height: number,
  pageWidth: number,
  pageHeight: number
): NormalizedRect => {
  const norm = {
    x: Math.max(0, Math.min(1, x / pageWidth)),
    y: Math.max(0, Math.min(1, y / pageHeight)),
    width: Math.max(0, Math.min(1, width / pageWidth)),
    height: Math.max(0, Math.min(1, height / pageHeight)),
  };
  return norm;
};

const normalizeRectFromBottomLeft = (
  x: number,
  y: number,
  width: number,
  height: number,
  pageWidth: number,
  pageHeight: number
): NormalizedRect => {
  const topLeftY = pageHeight - (y + height);
  return normalizeRectTopLeft(x, topLeftY, width, height, pageWidth, pageHeight);
};

registerDetector("text:pdfjs", {
  name: "Text layout heuristics (pdf.js)",
  description: "Uses pdf.js text content to guess fields from leader lines and checkbox glyphs.",
  async detect(context: DetectorContext): Promise<DetectionOutput> {
    const { module: pdfjsLib, error: pdfError } = await ensurePdfjs();
    if (!pdfjsLib) {
      return {
        documentId: context.sample.documentId,
        pages: [],
        summary: {
          detector: "text:pdfjs",
          blocked: [`pdfjs-dist: ${pdfError?.message ?? "module not available"}`],
        },
      };
    }

    const data = await fs.readFile(context.sample.pdfPath);
    const pdfData = new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength);
    const loadingTask = (pdfjsLib as { getDocument: (options: unknown) => { promise: Promise<unknown> } }).getDocument({ data: pdfData });
    const doc = (await loadingTask.promise) as {
      numPages: number;
      getPage(index: number): Promise<{
        getViewport(options: { scale: number }): { width: number; height: number; transform: number[] };
        getTextContent(): Promise<{ items: Array<{ str: string; transform: number[]; width: number; height?: number; fontName?: string }> }>;
      }>;
      destroy(): Promise<void>;
    };

    const pages: PagePrediction[] = [];

    try {
      for (let pageIndex = 0; pageIndex < doc.numPages; pageIndex += 1) {
        const page = await doc.getPage(pageIndex + 1);
        const viewport = page.getViewport({ scale: 1 });
        const { items } = await page.getTextContent();

        const predictions: PagePrediction["fields"] = [];

        for (const item of items) {
          const raw = item.str ?? "";
          if (!raw) continue;

          const transform = (pdfjsLib as { Util: { transform: (a: number[], b: number[]) => number[] } }).Util.transform(
            viewport.transform,
            item.transform
          );

          const x = transform[4];
          const y = transform[5];
          const fontSize = Math.max(6, Math.hypot(transform[2], transform[3]) || item.height || 10);
          const width = Math.max(4, item.width * viewport.scale || fontSize);
          const boxTop = viewport.height - y;

          const normalizedCheckbox = (size: number) =>
            normalizeRectTopLeft(
              x,
              Math.max(0, boxTop - size),
              size,
              size,
              viewport.width,
              viewport.height
            );

          const normalizedText = (boxWidth: number, boxHeight: number) =>
            normalizeRectTopLeft(
              x,
              Math.max(0, boxTop - boxHeight * 0.8),
              boxWidth,
              boxHeight,
              viewport.width,
              viewport.height
            );

          const trimmed = raw.trim();
          const cleaned = raw.replace(/\s+/g, "");

          if (CHECKBOX_TOKENS.has(trimmed) || CHECKBOX_PATTERN.test(raw)) {
            const size = Math.max(fontSize, width);
            predictions.push({
              type: "checkbox",
              rect: normalizedCheckbox(size),
              confidence: 0.55,
            });
            continue;
          }

          if (LEADER_FRAGMENT_REGEX.test(cleaned)) {
            const repetition = cleaned.match(LEADER_FRAGMENT_REGEX)?.[0]?.length ?? 3;
            const lineWidth = Math.max(width, fontSize * repetition * 0.4, 12);
            const lineHeight = Math.max(fontSize * 0.6, 3);
            predictions.push({
              type: "text",
              rect: normalizedText(lineWidth, lineHeight),
              confidence: 0.35,
            });
          }
        }

        pages.push({ pageIndex, fields: predictions });
      }
    } finally {
      await doc.destroy();
    }

    return {
      documentId: context.sample.documentId,
      pages,
      summary: { detector: "text:pdfjs" },
    };
  },
});

// --- AcroForm extraction (pdf-lib) -----------------------------------------

const mapAcroFieldType = (ctorName: string): FieldType | null => {
  switch (ctorName) {
    case "PDFTextField":
      return "text";
    case "PDFCheckBox":
      return "checkbox";
    case "PDFRadioGroup":
      return "radio";
    case "PDFDropdown":
      return "dropdown";
    case "PDFOptionList":
      return "listbox";
    case "PDFButton":
      return "button";
    case "PDFSignature":
      return "signature";
    default:
      return null;
  }
};

registerDetector("acroform:pdf-lib", {
  name: "Existing AcroForm (pdf-lib)",
  description: "Reads embedded AcroForm widgets via pdf-lib and reports them as detections.",
  async detect(context: DetectorContext): Promise<DetectionOutput> {
    let pdfLib: typeof import("pdf-lib");
    try {
      pdfLib = await import("pdf-lib");
    } catch (error) {
      return {
        documentId: context.sample.documentId,
        pages: [],
        summary: {
          detector: "acroform:pdf-lib",
          blocked: [`pdf-lib: ${(error as Error).message}`],
        },
      };
    }

    const data = await fs.readFile(context.sample.pdfPath);
    const doc = await pdfLib.PDFDocument.load(data);
    const form = doc.getForm();
    const fields = form.getFields();
    const pagesList = doc.getPages();

    const pages: PagePrediction[] = [];
    for (let i = 0; i < pagesList.length; i += 1) {
      pages.push({ pageIndex: i, fields: [] });
    }

    for (const field of fields) {
      const type = mapAcroFieldType(field.constructor.name);
      if (!type) continue;

      const widgets = field.acroField.getWidgets();
      for (const widget of widgets) {
        const page = widget.P();
        if (!page) continue;
        const pageIndex = pagesList.findIndex((candidate) => candidate === page);
        if (pageIndex < 0) continue;

        const pdfPage = pagesList[pageIndex];
        const rect = widget.getRectangle();
        const x = rect.x ?? rect.left ?? 0;
        const y = rect.y ?? rect.bottom ?? 0;
        const width = rect.width ?? Math.max(0, (rect.right ?? 0) - x);
        const height = rect.height ?? Math.max(0, (rect.top ?? 0) - y);

        const pageSize = pdfPage.getSize();
        const normalized = normalizeRectTopLeft(
          x,
          Math.max(0, pageSize.height - y - height),
          width,
          height,
          pageSize.width,
          pageSize.height
        );

        pages[pageIndex].fields.push({
          type,
          rect: normalized,
          confidence: 0.95,
          attributes: { source: "acroform" },
        });
      }
    }

    return {
      documentId: context.sample.documentId,
      pages,
      summary: { detector: "acroform:pdf-lib", fields: fields.length },
    };
  },
});

// --- Vector primitives via pdf.js -----------------------------------------

interface LineSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface RectPath {
  x: number;
  y: number;
  width: number;
  height: number;
}

registerDetector("vector:pdfjs", {
  name: "Vector primitives (pdf.js)",
  description: "Inspects pdf.js operator lists to find stroked lines and rectangles as field hints.",
  async detect(context: DetectorContext): Promise<DetectionOutput> {
    const { module: pdfjsLib, error: pdfError } = await ensurePdfjs();
    if (!pdfjsLib) {
      return {
        documentId: context.sample.documentId,
        pages: [],
        summary: {
          detector: "vector:pdfjs",
          blocked: [`pdfjs-dist: ${pdfError?.message ?? "module not available"}`],
        },
      };
    }

    const OPS = (pdfjsLib as { OPS: Record<string, number> }).OPS;
    const data = await fs.readFile(context.sample.pdfPath);
    const pdfData = new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength);
    const loadingTask = (pdfjsLib as { getDocument: (options: unknown) => { promise: Promise<unknown> } }).getDocument({ data: pdfData });
    const doc = (await loadingTask.promise) as {
      numPages: number;
      getPage(index: number): Promise<{
        getViewport(options: { scale: number }): { width: number; height: number };
        getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }>;
      }>;
      destroy(): Promise<void>;
    };

    const MIN_TEXT_LINE = 0.8 * 72;
    const MIN_SIGNATURE_LINE = 2.4 * 72;
    const MAX_LINE_TILT = 1.5; // allowable vertical drift in pts
    const LINE_HEIGHT = 8;
    const SIGNATURE_HEIGHT = 11;
    const CHECKBOX_MIN = 5;
    const CHECKBOX_MAX = 28;
    const CHECKBOX_RATIO_MIN = 0.75;
    const CHECKBOX_RATIO_MAX = 1.25;

    const pages: PagePrediction[] = [];

    try {
      for (let pageIndex = 0; pageIndex < doc.numPages; pageIndex += 1) {
        const page = await doc.getPage(pageIndex + 1);
        const viewport = page.getViewport({ scale: 1 });
        const operatorList = await page.getOperatorList();

        const segments: LineSegment[] = [];
        const rectangles: RectPath[] = [];

        const flushPaths = () => {
          const predictions: PagePrediction["fields"] = [];

          for (const rect of rectangles) {
            if (rect.width <= 0 || rect.height <= 0) continue;
            const shortSide = Math.min(rect.width, rect.height);
            const longSide = Math.max(rect.width, rect.height);
            const ratio = shortSide / longSide;
            if (
              shortSide >= CHECKBOX_MIN &&
              shortSide <= CHECKBOX_MAX &&
              ratio >= CHECKBOX_RATIO_MIN &&
              ratio <= CHECKBOX_RATIO_MAX
            ) {
              predictions.push({
                type: "checkbox",
                rect: normalizeRectFromBottomLeft(rect.x, rect.y, rect.width, rect.height, viewport.width, viewport.height),
                confidence: 0.6,
              });
            }
          }

          for (const segment of segments) {
            const dx = segment.x2 - segment.x1;
            const dy = segment.y2 - segment.y1;
            const length = Math.hypot(dx, dy);
            if (length < MIN_TEXT_LINE) continue;
            if (Math.abs(dy) > MAX_LINE_TILT) continue;

            const x = Math.min(segment.x1, segment.x2);
            const lineY = (segment.y1 + segment.y2) / 2;
            const bottom = lineY - LINE_HEIGHT / 2;

            const height = length >= MIN_SIGNATURE_LINE ? SIGNATURE_HEIGHT : LINE_HEIGHT;
            const rect = normalizeRectFromBottomLeft(x, bottom, length, height, viewport.width, viewport.height);

            predictions.push({
              type: length >= MIN_SIGNATURE_LINE ? "signature" : "text",
              rect,
              confidence: length >= MIN_SIGNATURE_LINE ? 0.55 : 0.4,
            });
          }

          rectangles.length = 0;
          segments.length = 0;

          return predictions;
        };

        const pagePredictions: PagePrediction["fields"] = [];
        const fnArray = operatorList.fnArray;
        const argsArray = operatorList.argsArray;

        const appendSegmentsFromPath = (ops: number[], args: number[]) => {
          let x = 0;
          let y = 0;
          let startX = 0;
          let startY = 0;
          let argIndex = 0;

          if (!Array.isArray(ops)) {
            return;
          }
          ops.forEach((op) => {
            switch (op) {
              case OPS.moveTo: {
                x = args[argIndex++];
                y = args[argIndex++];
                startX = x;
                startY = y;
                break;
              }
              case OPS.lineTo: {
                const newX = args[argIndex++];
                const newY = args[argIndex++];
                segments.push({ x1: x, y1: y, x2: newX, y2: newY });
                x = newX;
                y = newY;
                break;
              }
              case OPS.curveTo:
              case OPS.bezierCurveTo: {
                argIndex += 6;
                break;
              }
              case OPS.curveTo3:
              case OPS.curveTo2: {
                argIndex += 4;
                break;
              }
              case OPS.closePath: {
                segments.push({ x1: x, y1: y, x2: startX, y2: startY });
                x = startX;
                y = startY;
                break;
              }
              default: {
                break;
              }
            }
          });
        };

        const emitRectangle = (
          rawX: number,
          rawY: number,
          rawWidth: number,
          rawHeight: number
        ) => {
          if (rawWidth === 0 || rawHeight === 0) return;
          const width = Math.abs(rawWidth);
          const height = Math.abs(rawHeight);
          const x = rawWidth < 0 ? rawX - width : rawX;
          const y = rawHeight < 0 ? rawY - height : rawY;

          const ratio = Math.min(width, height) / Math.max(width, height);

          if (
            height <= 3.5 &&
            width >= MIN_TEXT_LINE
          ) {
            pagePredictions.push({
              type: width >= MIN_SIGNATURE_LINE ? "signature" : "text",
              rect: normalizeRectFromBottomLeft(
                x,
                y,
                width,
                width >= MIN_SIGNATURE_LINE ? SIGNATURE_HEIGHT : Math.max(height, LINE_HEIGHT),
                viewport.width,
                viewport.height
              ),
              confidence: width >= MIN_SIGNATURE_LINE ? 0.6 : 0.45,
            });
            return;
          }

          if (
            height >= CHECKBOX_MIN &&
            height <= CHECKBOX_MAX &&
            ratio >= CHECKBOX_RATIO_MIN &&
            ratio <= CHECKBOX_RATIO_MAX
          ) {
            pagePredictions.push({
              type: "checkbox",
              rect: normalizeRectFromBottomLeft(x, y, width, height, viewport.width, viewport.height),
              confidence: 0.65,
            });
            return;
          }

          if (width >= MIN_SIGNATURE_LINE && height <= 6) {
            pagePredictions.push({
              type: "signature",
              rect: normalizeRectFromBottomLeft(
                x,
                y,
                width,
                Math.max(height, SIGNATURE_HEIGHT),
                viewport.width,
                viewport.height
              ),
              confidence: 0.5,
            });
          }
        };

        for (let i = 0; i < fnArray.length; i += 1) {
          const fn = fnArray[i];
          const args = argsArray[i];

          if (fn === OPS.constructPath) {
            const [ops, coords] = args as [number[], number[]];
            appendSegmentsFromPath(ops, coords);
          } else if (fn === OPS.rectangle) {
            const [x, y, width, height] = args as [number, number, number, number];
            rectangles.push({ x, y, width, height });
            emitRectangle(x, y, width, height);
          } else if (
            fn === OPS.stroke ||
            fn === OPS.fillStroke ||
            fn === OPS.fill ||
            fn === OPS.endPath
          ) {
            pagePredictions.push(...flushPaths());
          }
        }

        pagePredictions.push(...flushPaths());

        pages.push({ pageIndex, fields: pagePredictions });
      }
    } finally {
      await doc.destroy();
    }

    return {
      documentId: context.sample.documentId,
      pages,
      summary: { detector: "vector:pdfjs" },
    };
  },
});

// --- Anchor-based heuristics (pdf.js) --------------------------------------

const LINE_Y_TOL = 3; // pts
const COLON_RIGHT_THRESHOLD = 0.9;
const PAD_X = 16;
const RIGHT_MARGIN_RATIO = 0.95;
const MIN_TEXT_WIDTH_PT = 60;
const MAX_TEXT_WIDTH_PT = 252; // ~3.5in at 72dpi
const SIGNATURE_WIDTH_PT = 200;
const DATE_WIDTH_PT = 80;
const MIN_LEADER_PT = 108; // 1.5in
const LINE_MAX_PER = 1;
const NMS_IOU = 0.35;
const CHECKBOX_PER_LINE = 2;
const CHECKBOX_SIZE_PT = 18; // ~0.25in
const NEXT_TOKEN_PADDING = 6;

const COLON_LABEL_WHITELIST = [
  "name",
  "address",
  "city",
  "state",
  "zip",
  "email",
  "phone",
  "date",
  "signature",
  "dob",
  "ssn",
  "county",
  "case",
  "docket",
];

const COLON_LABEL_EXCLUDE = [
  "court",
  "instructions",
  "page",
  "section",
  "plaintiff",
  "defendant",
  "commonwealth",
  "massachusetts",
];
const COLON_VERTICAL_OFFSET_MULTIPLIER = 6;
const SIGNATURE_VERTICAL_OFFSET_MULTIPLIER = 4;

interface TextSpan {
  text: string;
  x: number;
  width: number;
  fontSize: number;
  height: number;
  baseline: number;
}

interface LineGroup {
  items: TextSpan[];
  text: string;
  baseline: number;
}

const buildLineGroups = (
  items: Array<{ str: string; transform: number[]; width: number; height?: number }>,
  viewport: { width: number; height: number; transform: number[] },
  pdfjsLib: unknown
): LineGroup[] => {
  const Util = (pdfjsLib as { Util: { transform: (a: number[], b: number[]) => number[] } }).Util;
  const groups = new Map<number, LineGroup>();

  for (const item of items) {
    const raw = item.str ?? "";
    if (!raw.trim()) continue;

    const transform = Util.transform(viewport.transform, item.transform);
    const x = transform[4];
    const y = transform[5];
    const fontSize = Math.max(4, Math.hypot(transform[2], transform[3]) || item.height || 10);
    let width = Math.max(0, item.width);
    if (!width || width === 0) {
      width = Math.max(fontSize * Math.max(raw.length, 1) * 0.45, fontSize);
    }
    const height = Math.max(fontSize, item.height ?? fontSize);

    const key = Math.round(y / LINE_Y_TOL);
    const span: TextSpan = {
      text: raw,
      x,
      width,
      fontSize,
      height,
      baseline: y,
    };

    const entry = groups.get(key);
    if (entry) {
      entry.items.push(span);
    } else {
      groups.set(key, { items: [span], text: "", baseline: y });
    }
  }

  const result: LineGroup[] = [];
  for (const [, group] of groups.entries()) {
    group.items.sort((a, b) => a.x - b.x);
    group.text = group.items.map((span) => span.text).join("");
    result.push(group);
  }

  result.sort((a, b) => a.baseline - b.baseline);
  return result;
};

const rectIoU = (a: NormalizedRect, b: NormalizedRect): number => {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) {
    return 0;
  }
  const intersection = (right - left) * (bottom - top);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union <= 0 ? 0 : intersection / union;
};

const applyNms = (
  fields: PagePrediction["fields"],
  threshold: number
): PagePrediction["fields"] => {
  if (fields.length <= 1) {
    return fields;
  }

  const candidates = [...fields].sort(
    (a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height
  );

  const kept: PagePrediction["fields"] = [];

  while (candidates.length > 0) {
    const current = candidates.shift()!;
    kept.push(current);
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      if (rectIoU(current.rect, candidates[i].rect) >= threshold) {
        candidates.splice(i, 1);
      }
    }
  }

  return kept;
};

registerDetector("anchors:pdfjs", {
  name: "Label anchors (pdf.js)",
  description: "Anchors on colon labels and leader lines to suggest nearby fields.",
  async detect(context: DetectorContext): Promise<DetectionOutput> {
    const { module: pdfjsLib, error: pdfError } = await ensurePdfjs();
    if (!pdfjsLib) {
      return {
        documentId: context.sample.documentId,
        pages: [],
        summary: {
          detector: "anchors:pdfjs",
          blocked: [`pdfjs-dist: ${pdfError?.message ?? "module not available"}`],
        },
      };
    }

    const data = await fs.readFile(context.sample.pdfPath);
    const pdfData = new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength);
    const loadingTask = (pdfjsLib as { getDocument: (options: unknown) => { promise: Promise<unknown> } }).getDocument({ data: pdfData });
    const doc = (await loadingTask.promise) as {
      numPages: number;
      getPage(index: number): Promise<{
        getViewport(options: { scale: number }): { width: number; height: number; transform: number[] };
        getTextContent(): Promise<{ items: Array<{ str: string; transform: number[]; width: number; height?: number }> }>;
      }>;
      destroy(): Promise<void>;
    };

    const pages: PagePrediction[] = [];

    try {
      for (let pageIndex = 0; pageIndex < doc.numPages; pageIndex += 1) {
        const page = await doc.getPage(pageIndex + 1);
        const viewport = page.getViewport({ scale: 1 });
        const { items } = await page.getTextContent();
        const lines = buildLineGroups(items, viewport, pdfjsLib);
        const predictions: PagePrediction["fields"] = [];

        for (const line of lines) {
          const rawText = line.text;
          if (!rawText.trim()) continue;

          const spans = line.items;
          if (spans.length === 0) continue;

          const lineStartX = spans[0].x;
          const lineEndX = spans.reduce((acc, span) => Math.max(acc, span.x + span.width), lineStartX);
          const baseline = spans[0].baseline;
          const maxFont = spans.reduce((acc, span) => Math.max(acc, span.fontSize), 10);

          const lineColonCandidates: Array<{ field: PagePrediction["fields"][number]; width: number }> = [];
          const lineOutputs: PagePrediction["fields"] = [];
          let checkboxesPlaced = 0;

          if (rawText.includes(":")) {
            let colonX = lineStartX;
            let colonFont = maxFont;
            let found = false;
            for (const span of spans) {
              const index = span.text.indexOf(":");
              if (index !== -1) {
                const charWidth = span.text.length > 0 ? span.width / span.text.length : span.width || span.fontSize;
                colonX = span.x + charWidth * (index + 1);
                colonFont = span.fontSize;
                found = true;
                break;
              }
            }

            if (found) {
              const normalizedColon = colonX / viewport.width;
              if (normalizedColon <= COLON_RIGHT_THRESHOLD) {
                const labelText = rawText.split(":", 1)[0]?.toLowerCase() ?? "";
                const tokens = labelText.split(/[^a-z0-9]+/g).filter(Boolean);
                const hasWhitelist = tokens.some((token) => COLON_LABEL_WHITELIST.includes(token));
                const hasExclude = tokens.some((token) => COLON_LABEL_EXCLUDE.includes(token));
                if (hasWhitelist && !hasExclude) {
                  const anchorStart = Math.max(colonX + PAD_X, lineEndX + PAD_X * 0.25);
                  if (anchorStart < viewport.width) {
                    const rightLimit = viewport.width * RIGHT_MARGIN_RATIO;
                    const targetX = Math.min(anchorStart, rightLimit);
                    const nextSpan = spans.find((span) => span.x > colonX + NEXT_TOKEN_PADDING);
                    const pageRight = viewport.width - PAD_X;
                    let rightEdge = nextSpan ? Math.min(nextSpan.x - NEXT_TOKEN_PADDING, pageRight) : Math.min(targetX + MAX_TEXT_WIDTH_PT, pageRight);
                    rightEdge = Math.max(rightEdge, targetX + MIN_TEXT_WIDTH_PT);
                    let targetWidth = Math.min(rightEdge - targetX, MAX_TEXT_WIDTH_PT);
                    if (targetWidth >= MIN_TEXT_WIDTH_PT) {
                      let targetType: FieldType = "text";
                      if (tokens.includes("signature")) {
                        targetType = "signature";
                      } else if (tokens.includes("date") || tokens.includes("dob")) {
                        targetWidth = Math.max(Math.min(targetWidth, DATE_WIDTH_PT), MIN_TEXT_WIDTH_PT);
                      }

                      const fontForHeight = Math.max(colonFont, maxFont);
                      const baseHeight = targetType === "signature" ? fontForHeight * 1.5 : fontForHeight * 1.2;
                      const targetHeight = targetType === "signature" ? baseHeight : Math.max(baseHeight, fontForHeight * 4);
                      const offsetMultiplier = targetType === "signature"
                        ? SIGNATURE_VERTICAL_OFFSET_MULTIPLIER
                        : COLON_VERTICAL_OFFSET_MULTIPLIER;
                      const baseTop = baseline + fontForHeight * offsetMultiplier;
                      const clampedTop = Math.min(baseTop, viewport.height - targetHeight);
                      const top = Math.max(0, clampedTop);

                      lineColonCandidates.push({
                        width: targetWidth,
                        field: {
                          type: targetType,
                          rect: normalizeRectTopLeft(targetX, top, targetWidth, targetHeight, viewport.width, viewport.height),
                          confidence: targetType === "signature" ? 0.6 : 0.45,
                        },
                      });
                    }
                  }
                }
              }
            }
          }

          if (!rawText.includes(":") && /signature/i.test(rawText)) {
            const startX = lineEndX + PAD_X;
            const pageRight = viewport.width * RIGHT_MARGIN_RATIO;
            const width = Math.min(Math.max(SIGNATURE_WIDTH_PT, viewport.width * 0.35), pageRight - startX);
            if (width >= MIN_TEXT_WIDTH_PT && width <= MAX_TEXT_WIDTH_PT) {
              const height = maxFont * 1.4;
              const top = Math.max(0, baseline - height * 0.4);
              lineOutputs.push({
                type: "signature",
                rect: normalizeRectTopLeft(startX, top, width, height, viewport.width, viewport.height),
                confidence: 0.45,
              });
            }
          }

          if (LEADER_FRAGMENT_REGEX.test(rawText)) {
            for (const span of spans) {
              if (!LEADER_FRAGMENT_REGEX.test(span.text)) continue;
              const estimatedWidth = span.width || span.fontSize * span.text.length;
              if (estimatedWidth < MIN_LEADER_PT) continue;
              const width = Math.min(Math.max(estimatedWidth, MIN_TEXT_WIDTH_PT), MAX_TEXT_WIDTH_PT);
              const height = Math.max(span.fontSize * 0.6, 6);
              const top = Math.max(0, span.baseline - height * 0.6);
              lineOutputs.push({
                type: "text",
                rect: normalizeRectTopLeft(span.x, top, width, height, viewport.width, viewport.height),
                confidence: 0.35,
              });
            }
          }

          for (const span of spans) {
            if (checkboxesPlaced >= CHECKBOX_PER_LINE) break;
            const text = span.text ?? "";
            const indices: number[] = [];
            const pushIndex = (idx: number) => {
              if (idx >= 0) indices.push(idx);
            };
            pushIndex(text.indexOf("["));
            pushIndex(text.indexOf("☐"));
            pushIndex(text.indexOf("□"));
            if (indices.length === 0) {
              continue;
            }
            const charWidth = span.text.length > 0 ? span.width / span.text.length : span.fontSize;
            for (const idx of indices.sort((a, b) => a - b)) {
              if (checkboxesPlaced >= CHECKBOX_PER_LINE) break;
              const tokenX = span.x + Math.max(0, idx) * charWidth;
              const boxWidth = CHECKBOX_SIZE_PT;
              const boxX = Math.max(0, tokenX - boxWidth - 2);
              const boxHeight = boxWidth;
              const top = Math.max(0, span.baseline - boxHeight * 0.6);
              lineOutputs.push({
                type: "checkbox",
                rect: normalizeRectTopLeft(boxX, top, boxWidth, boxHeight, viewport.width, viewport.height),
                confidence: 0.4,
              });
              checkboxesPlaced += 1;
            }
          }

          lineColonCandidates.sort((a, b) => b.width - a.width);
          for (const candidate of lineColonCandidates.slice(0, LINE_MAX_PER)) {
            lineOutputs.push(candidate.field);
          }

          predictions.push(...lineOutputs);
        }

        const deduped = applyNms(predictions, NMS_IOU);
        pages.push({ pageIndex, fields: deduped });
      }
    } finally {
      await doc.destroy();
    }

    return {
      documentId: context.sample.documentId,
      pages,
      summary: { detector: "anchors:pdfjs" },
    };
  },
});
