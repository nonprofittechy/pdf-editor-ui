# PDF Form Designer

Interactive web app for uploading an existing PDF, visually placing AcroForm fields, editing their properties, and exporting an updated document. Built with Next.js, Tailwind CSS, pdf.js for rendering, and pdf-lib for AcroForm authoring.

## Features

- Upload any PDF and render each page with crisp zoom-friendly canvases.
- Draw bounding boxes to add single-line text, multi-line text, checkboxes, and digital signature fields.
- Drag-and-drop to reposition fields directly on the page overlay.
- Field inspector sidebar to rename labels, adjust fonts and sizing, and review every field at a glance.
- Export an updated PDF with embedded AcroForm fields ready for standard PDF readers.

## Getting Started

Install dependencies and launch the dev server:

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to use the designer.

For a production build:

```bash
npm run build
npm run start
```

## Usage

1. Upload a PDF via the **Upload PDF** control in the top toolbar.
2. Choose a field tool (Text, Multi-line, Checkbox, Signature) and drag on the page to draw the field bounds.
3. Drag placed fields to fine-tune their position. The overlay snaps to your drag movement.
4. Use the right-hand **Fields** panel to rename fields, tune fonts, toggle auto-sizing, or delete entries.
5. Click **Export PDF** to download a copy of the document with your fields embedded.

## Tech Stack

- Next.js 15 (App Router)
- Tailwind CSS for styling
- pdf.js for on-canvas PDF rendering
- pdf-lib for AcroForm creation and export

## Notes

- Signature widgets are exported as `/Sig` fields so they appear as digital signature placeholders in compliant PDF viewers.
- Text fields can use Helvetica, Times, or Courier families. Auto-size can be toggled off to enforce an explicit font size.

## Raster Detector Prereqs

The raster-based benchmark detector depends on the `canvas` package. If the module fails to install, run:

```bash
npm run preflight:canvas
```

Follow the printed OS-specific instructions (e.g., install Cairo, Pango, and related headers) and then reinstall dependencies with `npm install`.
