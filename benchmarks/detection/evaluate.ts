import type { FieldType, NormalizedRect } from "../../src/types/form";
import type {
  DetectionOutput,
  DocumentAnnotation,
  FieldAnnotation,
  FieldPrediction,
} from "./types";

export interface Instance<TField extends FieldAnnotation | FieldPrediction> {
  pageIndex: number;
  field: TField;
}

export interface MatchRecord {
  type: FieldType;
  pageIndex: number;
  truth: Instance<FieldAnnotation>;
  prediction: Instance<FieldPrediction>;
  iou: number;
}

export interface TypeCounts {
  tp: number;
  fp: number;
  fn: number;
}

export interface TypeMetrics extends TypeCounts {
  precision: number;
  recall: number;
  f1: number;
}

export interface AggregateMetrics {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  support: number;
  predicted: number;
}

export interface EvaluationReport {
  documentId: string;
  threshold: number;
  perType: Record<FieldType, TypeMetrics>;
  micro: AggregateMetrics;
  macro: AggregateMetrics;
  matches: MatchRecord[];
  falsePositives: Array<Instance<FieldPrediction>>;
  falseNegatives: Array<Instance<FieldAnnotation>>;
  summary?: Record<string, unknown>;
}

const clamp = (value: number): number => (Number.isFinite(value) ? value : 0);

const computeIoU = (a: NormalizedRect, b: NormalizedRect): number => {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);

  if (right <= left || bottom <= top) {
    return 0;
  }

  const intersection = (right - left) * (bottom - top);
  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  const union = areaA + areaB - intersection;

  return union <= 0 ? 0 : intersection / union;
};

interface MatchRun {
  matches: MatchRecord[];
  falsePositives: Array<Instance<FieldPrediction>>;
  falseNegatives: Array<Instance<FieldAnnotation>>;
}

const greedyMatch = (
  type: FieldType,
  truths: Array<Instance<FieldAnnotation>>,
  predictions: Array<Instance<FieldPrediction>>,
  threshold: number
): MatchRun => {
  const candidates: Array<{
    truthIndex: number;
    predictionIndex: number;
    iou: number;
  }> = [];

  truths.forEach((truth, truthIndex) => {
    predictions.forEach((prediction, predictionIndex) => {
      if (truth.pageIndex !== prediction.pageIndex) {
        return;
      }

      const iou = computeIoU(truth.field.rect, prediction.field.rect);
      if (iou >= threshold) {
        candidates.push({ truthIndex, predictionIndex, iou });
      }
    });
  });

  candidates.sort((a, b) => b.iou - a.iou);

  const matchedTruth = new Set<number>();
  const matchedPredictions = new Set<number>();
  const matches: MatchRecord[] = [];

  for (const candidate of candidates) {
    if (matchedTruth.has(candidate.truthIndex) || matchedPredictions.has(candidate.predictionIndex)) {
      continue;
    }

    const truthInstance = truths[candidate.truthIndex];
    const predictionInstance = predictions[candidate.predictionIndex];

    matches.push({
      type,
      pageIndex: truthInstance.pageIndex,
      truth: truthInstance,
      prediction: predictionInstance,
      iou: candidate.iou,
    });

    matchedTruth.add(candidate.truthIndex);
    matchedPredictions.add(candidate.predictionIndex);
  }

  const falseNegatives = truths.filter((_, index) => !matchedTruth.has(index));
  const falsePositives = predictions.filter((_, index) => !matchedPredictions.has(index));

  return {
    matches,
    falseNegatives,
    falsePositives,
  };
};

const calcMetrics = (counts: TypeCounts): TypeMetrics => {
  const precision = counts.tp + counts.fp === 0 ? 0 : counts.tp / (counts.tp + counts.fp);
  const recall = counts.tp + counts.fn === 0 ? 0 : counts.tp / (counts.tp + counts.fn);
  const denom = precision + recall;
  const f1 = denom === 0 ? 0 : (2 * precision * recall) / denom;

  return {
    ...counts,
    precision: clamp(precision),
    recall: clamp(recall),
    f1: clamp(f1),
  };
};

export const metricsFromCounts = (counts: TypeCounts): TypeMetrics => calcMetrics(counts);

const aggregateMetrics = (counts: TypeCounts): AggregateMetrics => {
  const metrics = calcMetrics(counts);
  return {
    tp: counts.tp,
    fp: counts.fp,
    fn: counts.fn,
    precision: metrics.precision,
    recall: metrics.recall,
    f1: metrics.f1,
    support: counts.tp + counts.fn,
    predicted: counts.tp + counts.fp,
  };
};

const flattenTruth = (annotation: DocumentAnnotation | null | undefined): Array<Instance<FieldAnnotation>> => {
  if (!annotation) {
    return [];
  }

  const instances: Array<Instance<FieldAnnotation>> = [];
  for (const page of annotation.pages) {
    for (const field of page.fields) {
      instances.push({ pageIndex: page.pageIndex, field });
    }
  }
  return instances;
};

const flattenPredictions = (output: DetectionOutput): Array<Instance<FieldPrediction>> => {
  const instances: Array<Instance<FieldPrediction>> = [];
  for (const page of output.pages) {
    for (const field of page.fields) {
      instances.push({ pageIndex: page.pageIndex, field });
    }
  }
  return instances;
};

export const evaluateDetectorOutput = (
  annotations: DocumentAnnotation | null | undefined,
  detections: DetectionOutput,
  threshold = 0.5
): EvaluationReport => {
  const truths = flattenTruth(annotations);
  const predictions = flattenPredictions(detections);

  const activeTypes = new Set<FieldType>();
  truths.forEach((instance) => activeTypes.add(instance.field.type));
  predictions.forEach((instance) => activeTypes.add(instance.field.type));

  const perTypeCounts = new Map<FieldType, TypeCounts>();
  const perTypeMetrics: Record<FieldType, TypeMetrics> = {} as Record<FieldType, TypeMetrics>;
  const matches: MatchRecord[] = [];
  const allFalsePositives: Array<Instance<FieldPrediction>> = [];
  const allFalseNegatives: Array<Instance<FieldAnnotation>> = [];

  let microCounts: TypeCounts = { tp: 0, fp: 0, fn: 0 };
  let macroPrecision = 0;
  let macroRecall = 0;
  let macroF1 = 0;
  let macroTypes = 0;

  for (const type of activeTypes) {
    const typeTruths = truths.filter((instance) => instance.field.type === type);
    const typePredictions = predictions.filter((instance) => instance.field.type === type);

    const typeRun = greedyMatch(type, typeTruths, typePredictions, threshold);

    matches.push(...typeRun.matches);
    allFalseNegatives.push(...typeRun.falseNegatives);
    allFalsePositives.push(...typeRun.falsePositives);

    const counts: TypeCounts = {
      tp: typeRun.matches.length,
      fp: typeRun.falsePositives.length,
      fn: typeRun.falseNegatives.length,
    };

    perTypeCounts.set(type, counts);
    const metrics = calcMetrics(counts);
    perTypeMetrics[type] = metrics;

    microCounts = {
      tp: microCounts.tp + counts.tp,
      fp: microCounts.fp + counts.fp,
      fn: microCounts.fn + counts.fn,
    };

    macroPrecision += metrics.precision;
    macroRecall += metrics.recall;
    macroF1 += metrics.f1;
    macroTypes += 1;
  }

  const micro = aggregateMetrics(microCounts);
  const macroDenominator = macroTypes === 0 ? 1 : macroTypes;
  const macro: AggregateMetrics = {
    tp: microCounts.tp,
    fp: microCounts.fp,
    fn: microCounts.fn,
    precision: macroTypes === 0 ? 0 : macroPrecision / macroDenominator,
    recall: macroTypes === 0 ? 0 : macroRecall / macroDenominator,
    f1: macroTypes === 0 ? 0 : macroF1 / macroDenominator,
    support: truths.length,
    predicted: predictions.length,
  };

  return {
    documentId: detections.documentId,
    threshold,
    perType: perTypeMetrics,
    micro,
    macro,
    matches,
    falsePositives: allFalsePositives,
    falseNegatives: allFalseNegatives,
    summary: detections.summary,
  };
};
