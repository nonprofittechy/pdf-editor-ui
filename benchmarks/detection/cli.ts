import { Command } from "commander";
import { promises as fs } from "fs";
import path from "path";

import { loadDataset } from "./dataset";
import { getDetector, listDetectors, requireDetector } from "./detectors";
import { evaluateDetectorOutput } from "./evaluate";
import type { EvaluationReport } from "./evaluate";
import type { DatasetSample } from "./types";

interface CliOptions {
  detector?: string;
  sample?: string;
  limit?: string;
  threshold?: string;
  outDir?: string;
  summary?: boolean;
}

const getSamples = async (
  sampleIds: string[] | undefined,
  limit: number
): Promise<DatasetSample[]> => {
  const allSamples = await loadDataset();
  if (!sampleIds || sampleIds.length === 0) {
    return allSamples.slice(0, limit);
  }

  const lowercased = sampleIds.map((s) => s.toLowerCase());
  const filtered = allSamples.filter((sample) =>
    lowercased.includes(sample.documentId.toLowerCase())
  );

  return filtered.slice(0, limit);
};

const main = async () => {
  const program = new Command();
  program
    .option("-d, --detector <id>", "detector to run")
    .option("-s, --sample <id...>", "run on a specific sample ID")
    .option("-l, --limit <n>", "limit number of samples to run")
    .option("-t, --threshold <n>", "IoU threshold for matching")
    .option("-o, --out-dir <path>", "directory to save evaluation reports")
    .option("--summary", "print a summary of results to stdout");

  program.parse(process.argv);
  const options = program.opts<CliOptions>();

  const detectorId = options.detector ?? "heuristic:pdfjs";
  const detector = getDetector(detectorId);
  if (!detector) {
    console.error(`Unknown detector: ${detectorId}`);
    console.log("Available detectors:");
    listDetectors().forEach((d) => console.log(`- ${d.id}: ${d.name}`));
    process.exit(1);
  }

  const limit = options.limit ? parseInt(options.limit, 10) : 10;
  const samples = await getSamples(options.sample, limit);
  const threshold = options.threshold ? parseFloat(options.threshold) : 0.5;

  console.log(`Running detector "${detector.name}" on ${samples.length} samples...`);

  const reports: EvaluationReport[] = [];

  for (const sample of samples) {
    if (!sample.annotations) {
      console.warn(`Skipping ${sample.documentId} (no annotations)`);
      continue;
    }

    const detections = await detector.detect({
      sample,
      datasetRoot: path.resolve(process.cwd(), "test"),
    });

    const report = evaluateDetectorOutput(sample.annotations, detections, threshold);
    reports.push(report);

    if (options.outDir) {
      await fs.mkdir(options.outDir, { recursive: true });
      const reportPath = path.join(options.outDir, `${sample.documentId}.${detectorId}.json`);
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    }
  }

  if (options.summary) {
    console.log("\n--- Summary ---");
    reports.forEach((report) => {
      console.log(`\nDocument: ${report.documentId}`);
      console.log(`  Micro F1: ${report.micro.f1.toFixed(3)}`);
      console.log(`  Macro F1: ${report.macro.f1.toFixed(3)}`);
    });
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});