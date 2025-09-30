import { evaluateDetectorOutput } from "./evaluate";
import type { DetectionOutput, DocumentAnnotation } from "./types";

const annotations: DocumentAnnotation = {
  documentId: "synthetic",
  pages: [
    {
      pageIndex: 0,
      fields: [
        {
          type: "text",
          rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
        },
        {
          type: "checkbox",
          rect: { x: 0.6, y: 0.4, width: 0.05, height: 0.05 },
        },
      ],
    },
  ],
};

const detections: DetectionOutput = {
  documentId: "synthetic",
  pages: [
    {
      pageIndex: 0,
      fields: [
        {
          type: "text",
          rect: { x: 0.105, y: 0.205, width: 0.29, height: 0.055 },
          confidence: 0.8,
        },
        {
          type: "text",
          rect: { x: 0.5, y: 0.5, width: 0.1, height: 0.05 },
          confidence: 0.4,
        },
      ],
    },
  ],
};

const report = evaluateDetectorOutput(annotations, detections, 0.5);

console.log("Smoke Test: synthetic evaluation");
console.log(`Precision: ${report.micro.precision.toFixed(2)}`);
console.log(`Recall: ${report.micro.recall.toFixed(2)}`);
console.log(`F1: ${report.micro.f1.toFixed(2)}`);

