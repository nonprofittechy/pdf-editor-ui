export type FieldType =
  | "text"
  | "multiline"
  | "checkbox"
  | "signature"
  | "radio"
  | "dropdown"
  | "listbox"
  | "button";

export type FieldFont =
  | "Helvetica"
  | "Helvetica-Bold"
  | "Times-Roman"
  | "Times-Bold"
  | "Courier"
  | "Courier-Bold";

export interface NormalizedRect {
  x: number; // 0-1 relative to page width
  y: number; // 0-1 relative to page height
  width: number; // 0-1 relative to page width
  height: number; // 0-1 relative to page height
}

export interface PdfField {
  id: string;
  name: string;
  type: FieldType;
  pageIndex: number;
  rect: NormalizedRect;
  autoSize: boolean;
  font: FieldFont;
  fontSize: number;
  options?: string[];
  widgetRects?: NormalizedRect[];
}
