import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const TEST_DIR = path.resolve(process.cwd(), "test");

export async function GET(request: NextRequest) {
  const fileParam = request.nextUrl.searchParams.get("file");

  if (!fileParam) {
    return NextResponse.json({ error: "Missing file parameter" }, { status: 400 });
  }

  const safeName = path.basename(fileParam);
  const pdfPath = path.join(TEST_DIR, safeName);

  try {
    const data = await fs.readFile(pdfPath);
    return new NextResponse(data, {
      headers: {
        "Content-Type": "application/pdf",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Failed to read PDF", error);
    return NextResponse.json({ error: "Unable to load requested PDF" }, { status: 404 });
  }
}

