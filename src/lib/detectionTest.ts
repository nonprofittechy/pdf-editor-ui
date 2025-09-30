/**
 * PDF Field Detection Test Suite
 * 
 * This module provides testing utilities to compare detection performance
 * between labeled and unlabeled versions of the same document.
 */

import { PDFFieldDetector } from './pdfFieldDetection';
import { DetectedElement } from '../types/form';

export interface TestResult {
  documentName: string;
  labeledFields: DetectedElement[];
  detectedFields: DetectedElement[];
  matches: FieldMatch[];
  missedFields: DetectedElement[];
  falsePositives: DetectedElement[];
  accuracy: number;
  precision: number;
  recall: number;
  summary: string;
}

export interface FieldMatch {
  labeled: DetectedElement;
  detected: DetectedElement;
  overlapRatio: number;
  typeMatch: boolean;
  quality: 'perfect' | 'good' | 'fair' | 'poor';
}

export class DetectionTester {
  private detector: PDFFieldDetector;

  constructor() {
    this.detector = new PDFFieldDetector({
      minTextFieldHeight: 12,
      maxFieldHeight: 200,
      minCheckboxSize: 8,
      maxCheckboxSize: 20,
      minRadioSize: 8,
      maxRadioSize: 16,
      mergeThreshold: 5,
      confidenceThreshold: 0.3 // Lower for testing
    });
  }

  /**
   * Test detection performance by comparing labeled vs unlabeled document
   */
  async testDocument(
    labeledImageData: ImageData,
    unlabeledImageData: ImageData,
    labeledTextElements: Array<{text: string, rect: {x: number, y: number, width: number, height: number}}>,
    unlabeledTextElements: Array<{text: string, rect: {x: number, y: number, width: number, height: number}}>,
    documentName: string
  ): Promise<TestResult> {
    
    // Extract expected fields from labeled document
    const labeledFields = this.extractExpectedFields(labeledImageData, labeledTextElements);
    
    // Run detection on unlabeled document
    const detectedFields = this.detector.detectFields(
      unlabeledImageData, 
      unlabeledImageData.width, 
      unlabeledImageData.height,
      unlabeledTextElements
    );

    // Compare results
    const matches = this.findMatches(labeledFields, detectedFields);
    const missedFields = this.findMissedFields(labeledFields, matches);
    const falsePositives = this.findFalsePositives(detectedFields, matches);

    // Calculate metrics
    const accuracy = this.calculateAccuracy(matches, missedFields, falsePositives);
    const precision = detectedFields.length > 0 ? matches.length / detectedFields.length : 0;
    const recall = labeledFields.length > 0 ? matches.length / labeledFields.length : 0;

    const summary = this.generateSummary(matches, missedFields, falsePositives, accuracy, precision, recall);

    return {
      documentName,
      labeledFields,
      detectedFields,
      matches,
      missedFields,
      falsePositives,
      accuracy,
      precision,
      recall,
      summary
    };
  }

  /**
   * Extract expected field locations from labeled document
   * In a labeled document, form fields should already be marked/visible
   */
  private extractExpectedFields(
    imageData: ImageData, 
    textElements: Array<{text: string, rect: {x: number, y: number, width: number, height: number}}>
  ): DetectedElement[] {
    
    // Use liberal settings to capture all possible fields in labeled version
    const liberalDetector = new PDFFieldDetector({
      minTextFieldHeight: 8, // Very permissive for labeled extraction
      maxFieldHeight: imageData.height * 0.8,
      minCheckboxSize: 6,
      maxCheckboxSize: 30,
      minRadioSize: 6,
      maxRadioSize: 20,
      mergeThreshold: 3,
      confidenceThreshold: 0.1 // Very low threshold
    });

    return liberalDetector.detectFields(imageData, imageData.width, imageData.height, textElements);
  }

  /**
   * Find matches between expected and detected fields
   */
  private findMatches(expected: DetectedElement[], detected: DetectedElement[]): FieldMatch[] {
    const matches: FieldMatch[] = [];
    const usedDetected = new Set<number>();

    for (const expectedField of expected) {
      let bestMatch: { index: number; detected: DetectedElement; overlapRatio: number } | null = null;

      for (let i = 0; i < detected.length; i++) {
        if (usedDetected.has(i)) continue;

        const detectedField = detected[i];
        const overlapRatio = this.calculateOverlapRatio(expectedField.rect, detectedField.rect);

        if (overlapRatio > 0.3 && (!bestMatch || overlapRatio > bestMatch.overlapRatio)) {
          bestMatch = { index: i, detected: detectedField, overlapRatio };
        }
      }

      if (bestMatch) {
        usedDetected.add(bestMatch.index);
        const typeMatch = expectedField.type === bestMatch.detected.type;
        const quality = this.assessMatchQuality(bestMatch.overlapRatio, typeMatch);

        matches.push({
          labeled: expectedField,
          detected: bestMatch.detected,
          overlapRatio: bestMatch.overlapRatio,
          typeMatch,
          quality
        });
      }
    }

    return matches;
  }

  /**
   * Find fields that were expected but not detected
   */
  private findMissedFields(expected: DetectedElement[], matches: FieldMatch[]): DetectedElement[] {
    const matchedExpected = new Set(matches.map(m => m.labeled));
    return expected.filter(field => !matchedExpected.has(field));
  }

  /**
   * Find fields that were detected but not expected (false positives)
   */
  private findFalsePositives(detected: DetectedElement[], matches: FieldMatch[]): DetectedElement[] {
    const matchedDetected = new Set(matches.map(m => m.detected));
    return detected.filter(field => !matchedDetected.has(field));
  }

  /**
   * Calculate overlap ratio between two rectangles
   */
  private calculateOverlapRatio(rect1: DetectedElement['rect'], rect2: DetectedElement['rect']): number {
    const x1 = Math.max(rect1.x, rect2.x);
    const y1 = Math.max(rect1.y, rect2.y);
    const x2 = Math.min(rect1.x + rect1.width, rect2.x + rect2.width);
    const y2 = Math.min(rect1.y + rect1.height, rect2.y + rect2.height);

    if (x2 <= x1 || y2 <= y1) return 0;

    const overlapArea = (x2 - x1) * (y2 - y1);
    const area1 = rect1.width * rect1.height;
    const area2 = rect2.width * rect2.height;
    const unionArea = area1 + area2 - overlapArea;

    return unionArea > 0 ? overlapArea / unionArea : 0;
  }

  /**
   * Assess the quality of a field match
   */
  private assessMatchQuality(overlapRatio: number, typeMatch: boolean): 'perfect' | 'good' | 'fair' | 'poor' {
    if (overlapRatio > 0.8 && typeMatch) return 'perfect';
    if (overlapRatio > 0.6 && typeMatch) return 'good';
    if (overlapRatio > 0.4 || typeMatch) return 'fair';
    return 'poor';
  }

  /**
   * Calculate overall accuracy
   */
  private calculateAccuracy(matches: FieldMatch[], missed: DetectedElement[], falsePositives: DetectedElement[]): number {
    const total = matches.length + missed.length + falsePositives.length;
    return total > 0 ? matches.length / total : 0;
  }

  /**
   * Generate human-readable summary
   */
  private generateSummary(
    matches: FieldMatch[], 
    missed: DetectedElement[], 
    falsePositives: DetectedElement[],
    accuracy: number,
    precision: number,
    recall: number
  ): string {
    const perfectMatches = matches.filter(m => m.quality === 'perfect').length;
    const goodMatches = matches.filter(m => m.quality === 'good').length;
    const fairMatches = matches.filter(m => m.quality === 'fair').length;
    const poorMatches = matches.filter(m => m.quality === 'poor').length;

    const typeBreakdown = this.getTypeBreakdown(missed, falsePositives);

    return `
Detection Performance Summary:
=============================
Accuracy: ${(accuracy * 100).toFixed(1)}%
Precision: ${(precision * 100).toFixed(1)}%  
Recall: ${(recall * 100).toFixed(1)}%

Match Quality:
- Perfect matches: ${perfectMatches}
- Good matches: ${goodMatches}  
- Fair matches: ${fairMatches}
- Poor matches: ${poorMatches}

Missed Fields (${missed.length}):
${typeBreakdown.missed}

False Positives (${falsePositives.length}):
${typeBreakdown.falsePositives}

Recommendations:
${this.generateRecommendations(matches, missed, falsePositives)}
`.trim();
  }

  /**
   * Analyze types of missed and false positive fields
   */
  private getTypeBreakdown(missed: DetectedElement[], falsePositives: DetectedElement[]): {missed: string, falsePositives: string} {
    const missedTypes = this.countByType(missed);
    const falsePositiveTypes = this.countByType(falsePositives);

    const formatCounts = (counts: Record<string, number>) => 
      Object.entries(counts).map(([type, count]) => `  ${type}: ${count}`).join('\n') || '  None';

    return {
      missed: formatCounts(missedTypes),
      falsePositives: formatCounts(falsePositiveTypes)
    };
  }

  /**
   * Count elements by type
   */
  private countByType(elements: DetectedElement[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const element of elements) {
      counts[element.type] = (counts[element.type] || 0) + 1;
    }
    return counts;
  }

  /**
   * Generate improvement recommendations based on test results
   */
  private generateRecommendations(matches: FieldMatch[], missed: DetectedElement[], falsePositives: DetectedElement[]): string {
    const recommendations: string[] = [];

    // Analyze missed fields
    const missedTextFields = missed.filter(f => f.type === 'text' || f.type === 'box').length;
    if (missedTextFields > 0) {
      recommendations.push(`- Improve text field detection: ${missedTextFields} text fields missed`);
    }

    const missedCheckboxes = missed.filter(f => f.type === 'checkbox').length;
    if (missedCheckboxes > 0) {
      recommendations.push(`- Enhance checkbox detection: ${missedCheckboxes} checkboxes missed`);
    }

    const missedRadio = missed.filter(f => f.type === 'radio').length;
    if (missedRadio > 0) {
      recommendations.push(`- Improve radio button detection: ${missedRadio} radio buttons missed`);
    }

    // Analyze false positives
    if (falsePositives.length > 5) {
      recommendations.push(`- Reduce false positives: ${falsePositives.length} incorrect detections`);
    }

    // Analyze match quality
    const poorMatches = matches.filter(m => m.quality === 'poor').length;
    if (poorMatches > 0) {
      recommendations.push(`- Improve positioning accuracy: ${poorMatches} poorly positioned matches`);
    }

    return recommendations.join('\n') || '- Detection quality looks good!';
  }

  /**
   * Create a visual report showing field positions
   */
  createVisualReport(testResult: TestResult): string {
    const canvas = `
<!DOCTYPE html>
<html>
<head>
    <title>Detection Test Report - ${testResult.documentName}</title>
    <style>
        body { font-family: monospace; margin: 20px; }
        .field { position: absolute; border: 2px solid; opacity: 0.7; }
        .expected { border-color: green; background: rgba(0,255,0,0.1); }
        .detected { border-color: blue; background: rgba(0,0,255,0.1); }
        .missed { border-color: red; background: rgba(255,0,0,0.1); }
        .false-positive { border-color: orange; background: rgba(255,165,0,0.1); }
        .container { position: relative; border: 1px solid #ccc; margin: 20px 0; }
        .legend { margin: 10px 0; }
        .legend span { display: inline-block; width: 20px; height: 20px; margin-right: 10px; vertical-align: middle; }
    </style>
</head>
<body>
    <h1>Detection Test Report: ${testResult.documentName}</h1>
    
    <div class="legend">
        <span style="background: rgba(0,255,0,0.3); border: 2px solid green;"></span> Expected Fields
        <span style="background: rgba(0,0,255,0.3); border: 2px solid blue;"></span> Detected Fields  
        <span style="background: rgba(255,0,0,0.3); border: 2px solid red;"></span> Missed Fields
        <span style="background: rgba(255,165,0,0.3); border: 2px solid orange;"></span> False Positives
    </div>
    
    <pre>${testResult.summary}</pre>
    
    <div class="container" style="width: 800px; height: 1000px;">
        ${this.generateFieldDivs(testResult)}
    </div>
</body>
</html>`;
    
    return canvas;
  }

  private generateFieldDivs(testResult: TestResult): string {
    const divs: string[] = [];
    
    // Scale factor to fit in container
    const scaleX = 800 / Math.max(...testResult.labeledFields.map(f => f.rect.x + f.rect.width), 1);
    const scaleY = 1000 / Math.max(...testResult.labeledFields.map(f => f.rect.y + f.rect.height), 1);
    const scale = Math.min(scaleX, scaleY);

    // Add matched fields (show overlap)
    for (const match of testResult.matches) {
      const rect = match.detected.rect;
      divs.push(`<div class="field detected" style="left: ${rect.x * scale}px; top: ${rect.y * scale}px; width: ${rect.width * scale}px; height: ${rect.height * scale}px;" title="Detected ${match.detected.type} (${match.quality} match)"></div>`);
    }

    // Add missed fields
    for (const missed of testResult.missedFields) {
      const rect = missed.rect;
      divs.push(`<div class="field missed" style="left: ${rect.x * scale}px; top: ${rect.y * scale}px; width: ${rect.width * scale}px; height: ${rect.height * scale}px;" title="Missed ${missed.type}"></div>`);
    }

    // Add false positives
    for (const fp of testResult.falsePositives) {
      const rect = fp.rect;
      divs.push(`<div class="field false-positive" style="left: ${rect.x * scale}px; top: ${rect.y * scale}px; width: ${rect.width * scale}px; height: ${rect.height * scale}px;" title="False positive ${fp.type}"></div>`);
    }

    return divs.join('\n');
  }
}

// Export utility function for easy testing
export async function runDetectionTest(
  labeledImageData: ImageData,
  unlabeledImageData: ImageData,
  labeledTextElements: Array<{text: string, rect: {x: number, y: number, width: number, height: number}}>,
  unlabeledTextElements: Array<{text: string, rect: {x: number, y: number, width: number, height: number}}>,
  documentName: string = 'test-document'
): Promise<TestResult> {
  const tester = new DetectionTester();
  return await tester.testDocument(
    labeledImageData, 
    unlabeledImageData,
    labeledTextElements,
    unlabeledTextElements,
    documentName
  );
}