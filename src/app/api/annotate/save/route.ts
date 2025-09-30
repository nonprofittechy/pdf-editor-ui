import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const TEST_DIR = path.resolve(process.cwd(), "test");

interface AnnotationPayload {
  documentId: string;
  pages: Array<{
    pageIndex: number;
    width: number;
    height: number;
    fields: Array<{
      id: string;
      type: string;
      rect: { x: number; y: number; width: number; height: number };
    }>;
  }>;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { pdfFile, annotation } = body as {
      pdfFile?: string;
      annotation?: AnnotationPayload;
    };

    if (!pdfFile || typeof pdfFile !== "string") {
      return NextResponse.json({ error: "Missing pdfFile" }, { status: 400 });
    }

    if (!annotation || typeof annotation !== "object") {
      return NextResponse.json({ error: "Missing annotation payload" }, { status: 400 });
    }

    const safeName = path.basename(pdfFile);
    const pdfPath = path.join(TEST_DIR, safeName);

    try {
      await fs.access(pdfPath);
    } catch {
      return NextResponse.json({ error: "PDF not found under /test" }, { status: 404 });
    }

    const outputPath = `${pdfPath}.groundtruth.json`;
    await fs.writeFile(outputPath, JSON.stringify(annotation, null, 2), "utf8");

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Failed to save annotation", error);
    return NextResponse.json({ error: "Unable to save annotation" }, { status: 500 });
  }
}

