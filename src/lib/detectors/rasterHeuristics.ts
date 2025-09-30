/**
 * Raster-based PDF field detection heuristics shared between the UI and benchmarks.
 */

import { DetectedElement } from "@/types/form";

export interface DetectionOptions {
  minTextFieldHeight: number; // Minimum height for text fields (should accommodate 10pt text)
  maxFieldHeight: number; // Maximum field height (e.g., 1/2 page height)
  minCheckboxSize: number;
  maxCheckboxSize: number;
  minRadioSize: number;
  maxRadioSize: number;
  mergeThreshold: number; // Distance threshold for merging adjacent fields
  confidenceThreshold: number;
}

export class PDFFieldDetector {
  private options: DetectionOptions;

  constructor(options?: Partial<DetectionOptions>) {
    this.options = {
      minTextFieldHeight: 12, // ~10pt text height
      maxFieldHeight: 200, // Will be adjusted based on page height
      minCheckboxSize: 8,
      maxCheckboxSize: 20,
      minRadioSize: 8,
      maxRadioSize: 16,
      mergeThreshold: 5,
      confidenceThreshold: 0.3,
      ...options,
    };
  }

  /**
   * Main detection method that finds all field types.
   */
  detectFields(
    imageData: ImageData,
    pageWidth: number,
    pageHeight: number,
    textElements?: Array<{
      text: string;
      rect: { x: number; y: number; width: number; height: number };
    }>
  ): DetectedElement[] {
    // Adjust max field height based on page size
    this.options.maxFieldHeight = Math.min(this.options.maxFieldHeight, pageHeight * 0.5);

    const elements: DetectedElement[] = [];

    // Detect different field types
    elements.push(...this.detectTextFields(imageData, pageWidth, pageHeight));
    elements.push(...this.detectCheckboxes(imageData, pageWidth, pageHeight));
    elements.push(...this.detectRadioButtons(imageData, pageWidth, pageHeight));
    elements.push(...this.detectSignatureAreas(imageData, pageWidth, pageHeight));
    elements.push(...this.detectStandaloneLines(imageData, pageWidth, pageHeight));

    // Filter out tiny elements (smaller than 10pt text)
    const sizeFilteredElements = this.filterByMinimumSize(elements, pageHeight);

    // Filter out elements that overlap with text (likely font artifacts)
    const textFilteredElements = textElements
      ? this.filterTextOverlaps(sizeFilteredElements, textElements)
      : sizeFilteredElements;

    // Merge overlapping or adjacent fields
    const mergedElements = this.mergeAdjacentFields(textFilteredElements);

    // Filter by confidence
    return mergedElements.filter((element) => element.confidence >= this.options.confidenceThreshold);
  }

  /**
   * Detect text input fields by finding horizontal lines and creating input boxes above them.
   */
  private detectTextFields(imageData: ImageData, width: number, height: number): DetectedElement[] {
    const elements: DetectedElement[] = [];
    const data = imageData.data;
    const threshold = 120;

    // First, find all horizontal lines
    const horizontalLines = this.findHorizontalLines(data, width, height, threshold);

    // For each horizontal line, create a text field box above it
    for (const line of horizontalLines) {
      if (line.width < 40) continue; // Skip very short lines

      // Calculate text field height (typically 10-16 points = 12-20 pixels)
      const fieldHeight = Math.max(this.options.minTextFieldHeight, Math.min(25, height * 0.025));

      // Position the text field box ABOVE the line (not overlapping)
      const textFieldY = Math.max(0, line.y - fieldHeight - 2); // 2px gap above line

      // Check if there's enough space above the line
      if (textFieldY >= 0 && line.y - textFieldY >= fieldHeight) {
        // Verify this area looks suitable for text input
        const confidence = this.calculateTextFieldAreaConfidence(
          data,
          line.x,
          textFieldY,
          line.width,
          fieldHeight,
          width,
          height
        );

        if (confidence > 0.2) {
          elements.push({
            type: "text",
            rect: {
              x: line.x,
              y: textFieldY,
              width: line.width,
              height: fieldHeight,
            },
            confidence,
          });
        }
      }
    }

    // Also detect rectangular text field boundaries (for boxed fields)
    elements.push(...this.detectBoxedTextFields(data, width, height, threshold));

    return elements;
  }

  /**
   * Find horizontal lines that could be underlines for text fields.
   */
  private findHorizontalLines(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    threshold: number
  ): Array<{ x: number; y: number; width: number }> {
    const lines: Array<{ x: number; y: number; width: number }> = [];

    // Scan every few rows for performance
    for (let y = 10; y < height - 10; y += 2) {
      let lineStart = -1;
      let lineLength = 0;
      let darkPixels = 0;
      let totalPixels = 0;

      for (let x = 5; x < width - 5; x++) {
        const brightness = this.getPixelBrightness(data, x, y, width);
        const isDark = brightness < threshold;

        if (isDark) {
          if (lineStart === -1) {
            lineStart = x;
          }
          lineLength = x - lineStart + 1;
          darkPixels++;
        } else {
          // Potential end of line - check if it's substantial enough
          if (lineLength >= 40 && darkPixels > lineLength * 0.7) {
            // Verify this is actually a horizontal line (not part of text)
            if (this.isLikelyUnderline(data, lineStart, y, lineLength, width, height, threshold)) {
              lines.push({
                x: lineStart,
                y: y,
                width: lineLength,
              });
            }
          }

          // Reset for next potential line
          lineStart = -1;
          lineLength = 0;
          darkPixels = 0;
        }
        totalPixels++;
      }

      // Check final line in row
      if (lineLength >= 40 && darkPixels > lineLength * 0.7) {
        if (this.isLikelyUnderline(data, lineStart, y, lineLength, width, height, threshold)) {
          lines.push({
            x: lineStart,
            y: y,
            width: lineLength,
          });
        }
      }
    }

    return lines;
  }

  /**
   * Check if a horizontal line is likely an underline (not part of text or other content).
   */
  private isLikelyUnderline(
    data: Uint8ClampedArray,
    x: number,
    y: number,
    width: number,
    imageWidth: number,
    imageHeight: number,
    threshold: number
  ): boolean {
    // Check area above the line - should be relatively clear (white space for text)
    const checkHeight = Math.min(20, y - 5);
    if (checkHeight <= 0) return false;

    let clearPixels = 0;
    let totalPixels = 0;

    for (let checkY = y - checkHeight; checkY < y - 2; checkY++) {
      for (let checkX = x; checkX < x + width && checkX < imageWidth; checkX += 3) {
        const brightness = this.getPixelBrightness(data, checkX, checkY, imageWidth);
        if (brightness > threshold + 20) clearPixels++; // Brighter than threshold
        totalPixels++;
      }
    }

    // Should have mostly clear space above (for text input)
    const clearRatio = totalPixels > 0 ? clearPixels / totalPixels : 0;

    return clearRatio > 0.55; // Require at least 55% clear space
  }

  /**
   * Estimate confidence that area above underline is a genuine field region.
   */
  private calculateTextFieldAreaConfidence(
    data: Uint8ClampedArray,
    x: number,
    y: number,
    width: number,
    height: number,
    imageWidth: number,
    imageHeight: number
  ): number {
    const sampleStepX = Math.max(1, Math.floor(width / 100));
    const sampleStepY = Math.max(1, Math.floor(height / 20));
    let brightPixels = 0;
    let totalPixels = 0;

    for (let sampleY = y; sampleY < Math.min(imageHeight, y + height); sampleY += sampleStepY) {
      for (let sampleX = x; sampleX < Math.min(imageWidth, x + width); sampleX += sampleStepX) {
        const brightness = this.getPixelBrightness(data, sampleX, sampleY, imageWidth);
        if (brightness > 200) brightPixels++;
        totalPixels++;
      }
    }

    if (totalPixels === 0) return 0;
    const brightRatio = brightPixels / totalPixels;

    // Higher bright ratio suggests empty space ready for typing.
    return Math.max(0, Math.min(1, brightRatio));
  }

  /**
   * Detect checkbox candidates by looking for small square regions with dark borders.
   */
  private detectCheckboxes(imageData: ImageData, width: number, height: number): DetectedElement[] {
    const data = imageData.data;
    const elements: DetectedElement[] = [];
    const minSize = this.options.minCheckboxSize;
    const maxSize = this.options.maxCheckboxSize;

    for (let y = 0; y < height - maxSize; y += 3) {
      for (let x = 0; x < width - maxSize; x += 3) {
        const size = this.detectSquareAt(data, width, height, x, y, minSize, maxSize, 0.65);
        if (!size) continue;

        elements.push({
          type: "checkbox",
          rect: { x, y, width: size, height: size },
          confidence: 0.7,
        });
      }
    }

    return elements;
  }

  /**
   * Detect radio buttons by finding circular dark borders.
   */
  private detectRadioButtons(imageData: ImageData, width: number, height: number): DetectedElement[] {
    const data = imageData.data;
    const elements: DetectedElement[] = [];
    const minSize = this.options.minRadioSize;
    const maxSize = this.options.maxRadioSize;

    for (let y = 0; y < height - maxSize; y += 3) {
      for (let x = 0; x < width - maxSize; x += 3) {
        const size = this.detectCircleAt(data, width, height, x, y, minSize, maxSize, 0.6);
        if (!size) continue;

        elements.push({
          type: "radio",
          rect: { x, y, width: size, height: size },
          confidence: 0.6,
        });
      }
    }

    return elements;
  }

  /**
   * Detect signature areas as wide rectangles.
   */
  private detectSignatureAreas(imageData: ImageData, width: number, height: number): DetectedElement[] {
    const data = imageData.data;
    const elements: DetectedElement[] = [];

    const minWidth = width * 0.2;
    const maxWidth = width * 0.8;
    const minHeight = Math.max(this.options.minTextFieldHeight * 1.5, 20);
    const maxHeight = Math.min(height * 0.06, this.options.maxFieldHeight);

    for (let y = 0; y < height - maxHeight; y += 4) {
      for (let x = 0; x < width - maxWidth; x += 4) {
        const signature = this.detectWideRectangle(
          data,
          width,
          height,
          x,
          y,
          minWidth,
          maxWidth,
          minHeight,
          maxHeight,
          0.45
        );

        if (!signature) continue;

        elements.push({
          type: "signature",
          rect: signature,
          confidence: 0.55,
        });
      }
    }

    return elements;
  }

  /**
   * Detect standalone lines that could be multi-field alignment guides.
   */
  private detectStandaloneLines(imageData: ImageData, width: number, height: number): DetectedElement[] {
    const data = imageData.data;
    const elements: DetectedElement[] = [];

    const horizontalLines = this.findHorizontalLines(data, width, height, 100);
    for (const line of horizontalLines) {
      elements.push({
        type: "line",
        rect: { x: line.x, y: line.y, width: line.width, height: 2 },
        confidence: 0.4,
      });
    }

    return elements;
  }

  private detectBoxedTextFields(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    threshold: number
  ): DetectedElement[] {
    const elements: DetectedElement[] = [];

    for (let y = 0; y < height - this.options.minTextFieldHeight; y += 3) {
      for (let x = 0; x < width - this.options.minTextFieldHeight; x += 3) {
        const rectangle = this.detectRectangleAt(data, width, height, x, y, threshold);
        if (!rectangle) continue;

        elements.push({
          type: "text",
          rect: rectangle,
          confidence: 0.5,
        });
      }
    }

    return elements;
  }

  private filterByMinimumSize(elements: DetectedElement[], pageHeight: number): DetectedElement[] {
    const minHeight = Math.max(this.options.minTextFieldHeight, pageHeight * 0.01);
    const minWidth = minHeight * 2;

    return elements.filter((element) => {
      if (element.rect.height < minHeight) return false;
      if (element.rect.width < minWidth && element.type === "text") return false;
      return true;
    });
  }

  private mergeAdjacentFields(elements: DetectedElement[]): DetectedElement[] {
    const merged: DetectedElement[] = [];
    const visited = new Array(elements.length).fill(false);

    for (let i = 0; i < elements.length; i++) {
      if (visited[i]) continue;
      let current = elements[i];
      visited[i] = true;

      for (let j = i + 1; j < elements.length; j++) {
        if (visited[j]) continue;
        const candidate = elements[j];

        if (this.shouldMerge(current, candidate)) {
          current = {
            ...current,
            rect: this.mergeRects(current.rect, candidate.rect),
            confidence: Math.max(current.confidence, candidate.confidence) * 0.9,
          };
          visited[j] = true;
        }
      }

      merged.push(current);
    }

    return merged;
  }

  private shouldMerge(a: DetectedElement, b: DetectedElement): boolean {
    if (a.type !== b.type) return false;

    const distanceX = Math.abs(a.rect.x - (b.rect.x + b.rect.width));
    const distanceY = Math.abs(a.rect.y - (b.rect.y + b.rect.height));

    const horizontalOverlap =
      Math.min(a.rect.x + a.rect.width, b.rect.x + b.rect.width) - Math.max(a.rect.x, b.rect.x);
    const verticalOverlap =
      Math.min(a.rect.y + a.rect.height, b.rect.y + b.rect.height) - Math.max(a.rect.y, b.rect.y);

    const closeHorizontally = distanceX < this.options.mergeThreshold;
    const closeVertically = distanceY < this.options.mergeThreshold;
    const overlappingHorizontally = horizontalOverlap > -this.options.mergeThreshold;
    const overlappingVertically = verticalOverlap > -this.options.mergeThreshold;

    return (closeHorizontally && overlappingVertically) || (closeVertically && overlappingHorizontally);
  }

  private mergeRects(
    a: DetectedElement["rect"],
    b: DetectedElement["rect"]
  ): DetectedElement["rect"] {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const maxX = Math.max(a.x + a.width, b.x + b.width);
    const maxY = Math.max(a.y + a.height, b.y + b.height);

    return {
      x,
      y,
      width: maxX - x,
      height: maxY - y,
    };
  }

  private filterTextOverlaps(
    elements: DetectedElement[],
    textElements: Array<{
      text: string;
      rect: { x: number; y: number; width: number; height: number };
    }>
  ): DetectedElement[] {
    return elements.filter((element) => {
      for (const textElement of textElements) {
        const overlap = this.calculateOverlapRatio(element.rect, textElement.rect);
        if (overlap > 0.3) {
          return false;
        }
      }
      return true;
    });
  }

  private calculateOverlapRatio(
    rect1: DetectedElement["rect"],
    rect2: { x: number; y: number; width: number; height: number }
  ): number {
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

  private getPixelBrightness(data: Uint8ClampedArray, x: number, y: number, width: number): number {
    const offset = (y * width + x) * 4;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  private detectSquareAt(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    x: number,
    y: number,
    minSize: number,
    maxSize: number,
    borderThreshold: number
  ): number | null {
    for (let size = minSize; size <= maxSize; size++) {
      if (x + size >= width || y + size >= height) break;

      const borderBrightness = this.measureBorderDarkness(data, width, x, y, size, size);
      if (borderBrightness > borderThreshold) {
        return size;
      }
    }

    return null;
  }

  private detectCircleAt(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    x: number,
    y: number,
    minSize: number,
    maxSize: number,
    borderThreshold: number
  ): number | null {
    for (let size = minSize; size <= maxSize; size++) {
      if (x + size >= width || y + size >= height) break;

      const radius = size / 2;
      const centerX = x + radius;
      const centerY = y + radius;
      const points = 12;
      let darkCount = 0;
      let total = 0;

      for (let i = 0; i < points; i++) {
        const angle = (2 * Math.PI * i) / points;
        const sampleX = Math.floor(centerX + radius * Math.cos(angle));
        const sampleY = Math.floor(centerY + radius * Math.sin(angle));
        if (sampleX < 0 || sampleX >= width || sampleY < 0 || sampleY >= height) continue;

        const brightness = this.getPixelBrightness(data, sampleX, sampleY, width);
        if (brightness < 140) darkCount++;
        total++;
      }

      if (total > 0 && darkCount / total > borderThreshold) {
        return size;
      }
    }

    return null;
  }

  private detectWideRectangle(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    x: number,
    y: number,
    minWidth: number,
    maxWidth: number,
    minHeight: number,
    maxHeight: number,
    borderThreshold: number
  ):
    | { x: number; y: number; width: number; height: number }
    | null {
    for (let rectWidth = minWidth; rectWidth <= maxWidth; rectWidth += 10) {
      for (let rectHeight = minHeight; rectHeight <= maxHeight; rectHeight += 5) {
        if (x + rectWidth >= width || y + rectHeight >= height) break;

        const borderBrightness = this.measureBorderDarkness(data, width, x, y, rectWidth, rectHeight);
        if (borderBrightness > borderThreshold) {
          return { x, y, width: rectWidth, height: rectHeight };
        }
      }
    }

    return null;
  }

  private detectRectangleAt(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    x: number,
    y: number,
    threshold: number
  ): { x: number; y: number; width: number; height: number } | null {
    const maxWidth = Math.min(width - x, 300);
    const maxHeight = Math.min(height - y, 100);

    for (let rectHeight = this.options.minTextFieldHeight; rectHeight < maxHeight; rectHeight += 5) {
      for (let rectWidth = this.options.minTextFieldHeight; rectWidth < maxWidth; rectWidth += 5) {
        const borderBrightness = this.measureBorderDarkness(data, width, x, y, rectWidth, rectHeight);
        const fillBrightness = this.measureFillBrightness(data, width, x, y, rectWidth, rectHeight);

        if (borderBrightness > 0.6 && fillBrightness > threshold + 40) {
          return { x, y, width: rectWidth, height: rectHeight };
        }
      }
    }

    return null;
  }

  private measureBorderDarkness(
    data: Uint8ClampedArray,
    width: number,
    x: number,
    y: number,
    rectWidth: number,
    rectHeight: number
  ): number {
    let darkPixels = 0;
    let totalPixels = 0;

    for (let currX = x; currX < x + rectWidth; currX++) {
      darkPixels += this.countDarkIf(data, width, currX, y);
      darkPixels += this.countDarkIf(data, width, currX, y + rectHeight);
      totalPixels += 2;
    }

    for (let currY = y; currY < y + rectHeight; currY++) {
      darkPixels += this.countDarkIf(data, width, x, currY);
      darkPixels += this.countDarkIf(data, width, x + rectWidth, currY);
      totalPixels += 2;
    }

    return totalPixels > 0 ? darkPixels / totalPixels : 0;
  }

  private measureFillBrightness(
    data: Uint8ClampedArray,
    width: number,
    x: number,
    y: number,
    rectWidth: number,
    rectHeight: number
  ): number {
    let totalBrightness = 0;
    let totalPixels = 0;

    for (let currY = y + 1; currY < y + rectHeight - 1; currY += 3) {
      for (let currX = x + 1; currX < x + rectWidth - 1; currX += 3) {
        totalBrightness += this.getPixelBrightness(data, currX, currY, width);
        totalPixels++;
      }
    }

    return totalPixels > 0 ? totalBrightness / totalPixels : 0;
  }

  private countDarkIf(data: Uint8ClampedArray, width: number, x: number, y: number): number {
    const brightness = this.getPixelBrightness(data, x, y, width);
    return brightness < 140 ? 1 : 0;
  }
}

