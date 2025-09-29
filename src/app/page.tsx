import PdfEditor from "@/components/PdfEditor";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main className="min-h-screen bg-slate-100 p-6">
      <div className="mx-auto flex h-[calc(100vh-3rem)] max-w-7xl flex-col">
        <header className="mb-4 flex flex-col gap-2">
          <h1 className="text-2xl font-bold text-slate-900">PDF Form Designer</h1>
          <p className="text-sm text-slate-600">
            Upload a PDF, draw AcroForm fields directly on the page, fine-tune their properties, and export an updated document with your form fields embedded.
          </p>
        </header>
        <section className="flex min-h-0 flex-1">
          <PdfEditor />
        </section>
      </div>
    </main>
  );
}
