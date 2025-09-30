/**
 * PDF Field Detection Library
 * 
 * This module provides sophisticated field detection algorithms for PDF forms,
 * including text fields, checkboxes, radio buttons, and signature areas.
 */

import { DetectedElement } from '@/types/form';

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
      ...options
    };
  }

  /**
   * Main detection method that finds all field types
   */
  detectFields(imageData: ImageData, pageWidth: number, pageHeight: number, textElements?: Array<{text: string, rect: {x: number, y: number, width: number, height: number}}>): DetectedElement[] {
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
    const textFilteredElements = textElements ? 
      this.filterTextOverlaps(sizeFilteredElements, textElements) : 
      sizeFilteredElements;

    // Merge overlapping or adjacent fields
    const mergedElements = this.mergeAdjacentFields(textFilteredElements);

    // Filter by confidence
    return mergedElements.filter(element => element.confidence >= this.options.confidenceThreshold);
  }

  /**
   * Detect text input fields by finding horizontal lines and creating input boxes above them
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
          data, line.x, textFieldY, line.width, fieldHeight, width, height
        );
        
        if (confidence > 0.2) {
          elements.push({
            type: 'text',
            rect: {
              x: line.x,
              y: textFieldY,
              width: line.width,
              height: fieldHeight
            },
            confidence
          });
        }
      }
    }

    // Also detect rectangular text field boundaries (for boxed fields)
    elements.push(...this.detectBoxedTextFields(data, width, height, threshold));

    return elements;
  }

  /**
   * Find horizontal lines that could be underlines for text fields
   */
  private findHorizontalLines(data: Uint8ClampedArray, width: number, height: number, threshold: number): Array<{x: number, y: number, width: number}> {
    const lines: Array<{x: number, y: number, width: number}> = [];
    
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
          if (lineLength >= 40 && darkPixels > lineLength * 0.7) { // At least 70% dark pixels
            
            // Verify this is actually a horizontal line (not part of text)
            if (this.isLikelyUnderline(data, lineStart, y, lineLength, width, height, threshold)) {
              lines.push({
                x: lineStart,
                y: y,
                width: lineLength
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
            width: lineLength
          });
        }
      }
    }

    return lines;
  }

  /**
   * Check if a horizontal line is likely an underline (not part of text or other content)
   */
  private isLikelyUnderline(data: Uint8ClampedArray, x: number, y: number, width: number, imageWidth: number, imageHeight: number, threshold: number): boolean {
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
    
    // Check that line itself is thin (not a thick border)
    let lineThickness = 1;
    for (let checkY = y + 1; checkY < Math.min(y + 5, imageHeight); checkY++) {
      let darkPixelsInRow = 0;
      for (let checkX = x; checkX < x + width && checkX < imageWidth; checkX += 2) {
        if (this.getPixelBrightness(data, checkX, checkY, imageWidth) < threshold) {
          darkPixelsInRow++;
        }
      }
      if (darkPixelsInRow > width * 0.5) {
        lineThickness++;
      } else {
        break;
      }
    }
    
    return clearRatio > 0.6 && lineThickness <= 3; // Mostly clear above, thin line
  }

  /**
   * Calculate confidence that an area above a line is suitable for text input
   */
  private calculateTextFieldAreaConfidence(data: Uint8ClampedArray, x: number, y: number, width: number, height: number, imageWidth: number, imageHeight: number): number {
    let score = 0.4; // Base score
    
    // Check that the area is mostly clear (white space)
    let clearArea = 0;
    let totalArea = 0;
    
    for (let checkY = y; checkY < y + height && checkY < imageHeight; checkY += 2) {
      for (let checkX = x; checkX < x + width && checkX < imageWidth; checkX += 3) {
        const brightness = this.getPixelBrightness(data, checkX, checkY, imageWidth);
        if (brightness > 180) clearArea++; // White-ish
        totalArea++;
      }
    }
    
    const clearRatio = totalArea > 0 ? clearArea / totalArea : 0;
    score += clearRatio * 0.4; // Up to 0.4 bonus for clear area
    
    // Bonus for reasonable aspect ratio
    const aspectRatio = width / height;
    if (aspectRatio > 3 && aspectRatio < 20) {
      score += 0.2;
    }
    
    return Math.min(1.0, score);
  }

  /**
   * Detect text fields that are enclosed in boxes/rectangles
   */
  private detectBoxedTextFields(data: Uint8ClampedArray, width: number, height: number, threshold: number): DetectedElement[] {
    const elements: DetectedElement[] = [];
    
    // Sample sparsely for performance
    for (let y = 15; y < height - 25; y += 8) {
      for (let x = 15; x < width - 40; x += 10) {
        
        // Try different sizes for rectangular text fields
        for (let w = 40; w <= Math.min(300, width - x - 10); w += 20) {
          for (let h = this.options.minTextFieldHeight; h <= Math.min(40, height - y - 10); h += 4) {
            
            const confidence = this.detectRectangularBoundary(data, x, y, w, h, width, height, threshold);
            
            if (confidence > 0.3) {
              elements.push({
                type: 'text',
                rect: { x, y, width: w, height: h },
                confidence
              });
              
              // Skip overlapping detections
              x += w - 10;
              break;
            }
          }
        }
      }
    }
    
    return elements;
  }

  /**
   * Detect rectangular boundary around a potential text field
   */
  private detectRectangularBoundary(data: Uint8ClampedArray, x: number, y: number, w: number, h: number, imageWidth: number, imageHeight: number, threshold: number): number {
    if (x + w >= imageWidth || y + h >= imageHeight) return 0;
    
    let borderPixels = 0;
    let totalBorderPixels = 0;
    
    // Check top and bottom borders
    for (let i = 0; i < w; i += 2) {
      totalBorderPixels += 2;
      if (this.getPixelBrightness(data, x + i, y, imageWidth) < threshold) borderPixels++;
      if (this.getPixelBrightness(data, x + i, y + h - 1, imageWidth) < threshold) borderPixels++;
    }
    
    // Check left and right borders
    for (let i = 2; i < h - 2; i += 2) {
      totalBorderPixels += 2;
      if (this.getPixelBrightness(data, x, y + i, imageWidth) < threshold) borderPixels++;
      if (this.getPixelBrightness(data, x + w - 1, y + i, imageWidth) < threshold) borderPixels++;
    }
    
    const borderRatio = totalBorderPixels > 0 ? borderPixels / totalBorderPixels : 0;
    
    // Check interior is mostly clear
    let clearPixels = 0;
    let interiorPixels = 0;
    
    for (let checkY = y + 2; checkY < y + h - 2; checkY += 2) {
      for (let checkX = x + 2; checkX < x + w - 2; checkX += 3) {
        const brightness = this.getPixelBrightness(data, checkX, checkY, imageWidth);
        if (brightness > 160) clearPixels++;
        interiorPixels++;
      }
    }
    
    const clearRatio = interiorPixels > 0 ? clearPixels / interiorPixels : 0;
    
    // Combined score
    return (borderRatio * 0.6 + clearRatio * 0.4);
  }

  /**
   * Detect rectangular boundaries and calculate appropriate field height
   */
  private detectCheckboxes(imageData: ImageData, width: number, height: number): DetectedElement[] {
    const elements: DetectedElement[] = [];
    const data = imageData.data;

    // Sample sparsely but check more thoroughly for squares
    for (let y = 10; y < height - 20; y += 8) {
      for (let x = 10; x < width - 20; x += 8) {
        for (let size = this.options.minCheckboxSize; size <= this.options.maxCheckboxSize; size += 2) {
          const confidence = this.detectSquareShape(data, x, y, size, width, height);
          
          if (confidence > 0.25) {
            elements.push({
              type: 'checkbox',
              rect: { x, y, width: size, height: size },
              confidence
            });
            break; // Found a checkbox at this location
          }
        }
      }
    }

    return elements;
  }

  /**
   * Detect circular radio button elements
   */
  private detectRadioButtons(imageData: ImageData, width: number, height: number): DetectedElement[] {
    const elements: DetectedElement[] = [];
    const data = imageData.data;

    // Sample for circular shapes
    for (let y = 15; y < height - 15; y += 6) {
      for (let x = 15; x < width - 15; x += 6) {
        for (let radius = this.options.minRadioSize/2; radius <= this.options.maxRadioSize/2; radius += 1) {
          const confidence = this.detectCircularShape(data, x, y, radius, width, height);
          
          if (confidence > 0.3) {
            const size = radius * 2;
            elements.push({
              type: 'radio',
              rect: { 
                x: x - radius, 
                y: y - radius, 
                width: size, 
                height: size 
              },
              confidence
            });
            break; // Found a radio button at this location
          }
        }
      }
    }

    return elements;
  }

  /**
   * Detect signature areas (typically larger rectangular regions)
   */
  private detectSignatureAreas(imageData: ImageData, width: number, height: number): DetectedElement[] {
    const elements: DetectedElement[] = [];
    const data = imageData.data;

    const minWidth = Math.floor(width * 0.15);
    const minHeight = Math.floor(height * 0.03);

    for (let y = height * 0.1; y < height * 0.9; y += 15) {
      for (let x = width * 0.1; x < width * 0.8; x += 15) {
        const rect = this.detectLargeRectangle(data, x, y, minWidth, minHeight, width, height);
        
        if (rect) {
          const aspectRatio = rect.width / rect.height;
          if (aspectRatio > 3 && aspectRatio < 10) {
            elements.push({
              type: 'signature',
              rect,
              confidence: 0.6
            });
          }
        }
      }
    }

    return elements;
  }

  /**
   * Detect standalone lines (underlines, form lines)
   */
  private detectStandaloneLines(imageData: ImageData, width: number, height: number): DetectedElement[] {
    const elements: DetectedElement[] = [];
    const data = imageData.data;
    const threshold = 120;

    // Look for horizontal lines
    for (let y = 10; y < height - 10; y += 4) {
      let lineStart = -1;
      let lineLength = 0;

      for (let x = 10; x < width - 10; x++) {
        const brightness = this.getPixelBrightness(data, x, y, width);
        
        if (brightness < threshold) {
          if (lineStart === -1) {
            lineStart = x;
          }
          lineLength = x - lineStart + 1;
        } else {
          if (lineLength > 40) { // Longer minimum for standalone lines
            // Check if this is really a standalone line (not part of a text field)
            const isStandalone = this.isStandaloneLine(data, lineStart, y, lineLength, width, height);
            
            if (isStandalone) {
              elements.push({
                type: 'box',
                rect: {
                  x: lineStart,
                  y: y - 2,
                  width: lineLength,
                  height: 4
                },
                confidence: 0.7
              });
            }
          }
          lineStart = -1;
          lineLength = 0;
        }
      }
    }

    return elements;
  }

  /**
   * Detect square shapes for checkboxes
   */
  private detectSquareShape(
    data: Uint8ClampedArray,
    x: number,
    y: number,
    size: number,
    width: number,
    height: number
  ): number {
    if (x + size >= width || y + size >= height) return 0;

    const threshold = 120;
    let borderPixels = 0;
    let totalBorderPixels = 0;

    // Check all four edges
    for (let i = 0; i < size; i++) {
      // Top edge
      totalBorderPixels++;
      if (this.getPixelBrightness(data, x + i, y, width) < threshold) borderPixels++;
      
      // Bottom edge
      totalBorderPixels++;
      if (this.getPixelBrightness(data, x + i, y + size - 1, width) < threshold) borderPixels++;
      
      // Left edge
      if (i > 0 && i < size - 1) { // Avoid double counting corners
        totalBorderPixels++;
        if (this.getPixelBrightness(data, x, y + i, width) < threshold) borderPixels++;
        
        // Right edge
        totalBorderPixels++;
        if (this.getPixelBrightness(data, x + size - 1, y + i, width) < threshold) borderPixels++;
      }
    }

    return borderPixels / totalBorderPixels;
  }

  /**
   * Detect circular shapes for radio buttons
   */
  private detectCircularShape(
    data: Uint8ClampedArray,
    centerX: number,
    centerY: number,
    radius: number,
    width: number,
    height: number
  ): number {
    const threshold = 120;
    let borderPixels = 0;
    let totalPixels = 0;

    // Sample points around the circle
    const samples = 16;
    for (let i = 0; i < samples; i++) {
      const angle = (i * 2 * Math.PI) / samples;
      const x = Math.round(centerX + radius * Math.cos(angle));
      const y = Math.round(centerY + radius * Math.sin(angle));

      if (x >= 0 && x < width && y >= 0 && y < height) {
        totalPixels++;
        if (this.getPixelBrightness(data, x, y, width) < threshold) {
          borderPixels++;
        }
      }
    }

    return totalPixels > 0 ? borderPixels / totalPixels : 0;
  }

  /**
   * Detect larger rectangular areas for signatures
   */
  private detectLargeRectangle(
    data: Uint8ClampedArray,
    startX: number,
    startY: number,
    minWidth: number,
    minHeight: number,
    imageWidth: number,
    imageHeight: number
  ): { x: number; y: number; width: number; height: number } | null {
    const threshold = 120;

    // Look for horizontal lines first
    let width = 0;
    for (let x = startX; x < imageWidth && x < startX + minWidth * 2; x++) {
      if (this.getPixelBrightness(data, x, startY, imageWidth) < threshold) {
        width++;
      } else if (width > minWidth) {
        break;
      }
    }

    if (width < minWidth) return null;

    // Look for vertical extent
    let height = 0;
    for (let y = startY; y < imageHeight && y < startY + minHeight * 2; y++) {
      const hasLeftEdge = this.getPixelBrightness(data, startX, y, imageWidth) < threshold;
      const hasRightEdge = this.getPixelBrightness(data, startX + width - 1, y, imageWidth) < threshold;
      
      if (hasLeftEdge || hasRightEdge) {
        height++;
      } else if (height > minHeight) {
        break;
      }
    }

    return height >= minHeight ? { x: startX, y: startY, width, height } : null;
  }

  /**
   * Check if a detected line is standalone (not part of a text field)
   */
  private isStandaloneLine(
    data: Uint8ClampedArray,
    x: number,
    y: number,
    width: number,
    imageWidth: number,
    imageHeight: number
  ): boolean {
    const threshold = 120;
    const checkDistance = 8;

    // Check above and below the line for other boundaries
    let linesAbove = 0;
    let linesBelow = 0;

    for (let checkY = Math.max(0, y - checkDistance); checkY < y; checkY++) {
      let linePixels = 0;
      for (let checkX = x; checkX < x + width && checkX < imageWidth; checkX += 3) {
        if (this.getPixelBrightness(data, checkX, checkY, imageWidth) < threshold) {
          linePixels++;
        }
      }
      if (linePixels > width * 0.3) linesAbove++;
    }

    for (let checkY = y + 1; checkY <= Math.min(imageHeight - 1, y + checkDistance); checkY++) {
      let linePixels = 0;
      for (let checkX = x; checkX < x + width && checkX < imageWidth; checkX += 3) {
        if (this.getPixelBrightness(data, checkX, checkY, imageWidth) < threshold) {
          linePixels++;
        }
      }
      if (linePixels > width * 0.3) linesBelow++;
    }

    // If there are parallel lines nearby, it's probably part of a text field
    return linesAbove === 0 && linesBelow === 0;
  }

  /**
   * Merge adjacent or overlapping fields
   */
  private mergeAdjacentFields(elements: DetectedElement[]): DetectedElement[] {
    const merged: DetectedElement[] = [];
    const used = new Set<number>();

    for (let i = 0; i < elements.length; i++) {
      if (used.has(i)) continue;

      const current = elements[i];
      const toMerge = [current];
      used.add(i);

      // Find adjacent elements of the same type
      for (let j = i + 1; j < elements.length; j++) {
        if (used.has(j)) continue;

        const other = elements[j];
        if (current.type === other.type && this.areAdjacent(current.rect, other.rect)) {
          toMerge.push(other);
          used.add(j);
        }
      }

      // Merge the elements
      if (toMerge.length > 1) {
        merged.push(this.mergeRects(toMerge));
      } else {
        merged.push(current);
      }
    }

    return merged;
  }

  /**
   * Check if two rectangles are adjacent
   */
  private areAdjacent(rect1: DetectedElement['rect'], rect2: DetectedElement['rect']): boolean {
    const threshold = this.options.mergeThreshold;
    
    // Check horizontal adjacency
    const horizontalOverlap = Math.max(0, 
      Math.min(rect1.x + rect1.width, rect2.x + rect2.width) - 
      Math.max(rect1.x, rect2.x)
    );
    
    const verticalDistance = Math.abs(
      (rect1.y + rect1.height / 2) - (rect2.y + rect2.height / 2)
    );

    if (horizontalOverlap > Math.min(rect1.width, rect2.width) * 0.5 && 
        verticalDistance <= threshold) {
      return true;
    }

    // Check vertical adjacency
    const verticalOverlap = Math.max(0,
      Math.min(rect1.y + rect1.height, rect2.y + rect2.height) -
      Math.max(rect1.y, rect2.y)
    );

    const horizontalDistance = Math.abs(
      (rect1.x + rect1.width / 2) - (rect2.x + rect2.width / 2)
    );

    return verticalOverlap > Math.min(rect1.height, rect2.height) * 0.5 && 
           horizontalDistance <= threshold;
  }

  /**
   * Merge multiple rectangles into one
   */
  private mergeRects(elements: DetectedElement[]): DetectedElement {
    const rects = elements.map(e => e.rect);
    const minX = Math.min(...rects.map(r => r.x));
    const minY = Math.min(...rects.map(r => r.y));
    const maxX = Math.max(...rects.map(r => r.x + r.width));
    const maxY = Math.max(...rects.map(r => r.y + r.height));

    return {
      type: elements[0].type,
      rect: {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY
      },
      confidence: Math.max(...elements.map(e => e.confidence))
    };
  }

  /**
   * Count border pixels around a rectangle
   */
  private countBorderPixels(
    data: Uint8ClampedArray,
    x: number,
    y: number,
    width: number,
    height: number,
    imageWidth: number,
    imageHeight: number,
    threshold: number
  ): number {
    let borderPixels = 0;

    // Top and bottom edges
    for (let i = 0; i < width; i++) {
      if (x + i < imageWidth) {
        if (y >= 0 && this.getPixelBrightness(data, x + i, y, imageWidth) < threshold) {
          borderPixels++;
        }
        if (y + height - 1 < imageHeight && 
            this.getPixelBrightness(data, x + i, y + height - 1, imageWidth) < threshold) {
          borderPixels++;
        }
      }
    }

    // Left and right edges (excluding corners already counted)
    for (let i = 1; i < height - 1; i++) {
      if (y + i < imageHeight) {
        if (x >= 0 && this.getPixelBrightness(data, x, y + i, imageWidth) < threshold) {
          borderPixels++;
        }
        if (x + width - 1 < imageWidth && 
            this.getPixelBrightness(data, x + width - 1, y + i, imageWidth) < threshold) {
          borderPixels++;
        }
      }
    }

    return borderPixels;
  }

  /**
   * Get pixel brightness at coordinates
   */
  private getPixelBrightness(data: Uint8ClampedArray, x: number, y: number, width: number): number {
    if (x < 0 || y < 0 || x >= width) return 255;
    
    const index = (y * width + x) * 4;
    if (index >= data.length - 2) return 255;
    
    return (data[index] + data[index + 1] + data[index + 2]) / 3;
  }

  /**
   * Filter out elements that are too small to be real form fields
   * Minimum size should accommodate 10pt text (approximately 12-15 pixels)
   */
  private filterByMinimumSize(elements: DetectedElement[], pageHeight: number): DetectedElement[] {
    // Calculate minimum sizes based on page dimensions
    const minTextFieldHeight = Math.max(12, pageHeight * 0.015); // At least 12px or 1.5% of page height
    const minCheckboxSize = Math.max(8, pageHeight * 0.01); // At least 8px or 1% of page height
    const minRadioSize = Math.max(8, pageHeight * 0.01);
    const minSignatureHeight = Math.max(15, pageHeight * 0.02); // Signatures should be larger

    return elements.filter(element => {
      const { width, height } = element.rect;

      switch (element.type) {
        case 'text':
        case 'box':
          // Text fields should be at least tall enough for 10pt text
          return height >= minTextFieldHeight && width >= 20; // Also need minimum width
        
        case 'checkbox':
          // Checkboxes should be square-ish and reasonably sized
          return Math.min(width, height) >= minCheckboxSize && 
                 Math.max(width, height) <= minCheckboxSize * 3; // Not too elongated
        
        case 'radio':
          // Radio buttons should be circular and reasonably sized
          return Math.min(width, height) >= minRadioSize && 
                 Math.abs(width - height) <= Math.max(width, height) * 0.3; // Roughly circular
        
        case 'signature':
          // Signature areas should be substantial
          return height >= minSignatureHeight && width >= minSignatureHeight * 2;
        
        case 'line':
          // Lines should have reasonable length but can be thin
          return width >= 30 && height >= 1;
        
        default:
          return true; // Keep unknown types
      }
    });
  }

  /**
   * Filter out elements that significantly overlap with text content
   * This removes artifacts found within font glyphs
   */
  private filterTextOverlaps(elements: DetectedElement[], textElements: Array<{text: string, rect: {x: number, y: number, width: number, height: number}}>): DetectedElement[] {
    return elements.filter(element => {
      // Check if this element significantly overlaps with any text
      for (const textEl of textElements) {
        const overlapRatio = this.calculateRectangleOverlapRatio(element.rect, textEl.rect);
        
        // If the detected element overlaps more than 40% with text, it's likely a font artifact
        if (overlapRatio > 0.4) {
          // Additional check: if it's a very small element entirely contained within text, definitely remove it
          if (this.isRectangleContainedWithin(element.rect, textEl.rect)) {
            return false;
          }
          
          // For larger overlaps, be more cautious but still filter out likely artifacts
          if (overlapRatio > 0.7) {
            return false;
          }
        }
      }
      
      return true; // Keep elements that don't significantly overlap with text
    });
  }

  /**
   * Calculate the overlap ratio between two rectangles
   */
  private calculateRectangleOverlapRatio(rect1: {x: number, y: number, width: number, height: number}, rect2: {x: number, y: number, width: number, height: number}): number {
    const x1 = Math.max(rect1.x, rect2.x);
    const y1 = Math.max(rect1.y, rect2.y);
    const x2 = Math.min(rect1.x + rect1.width, rect2.x + rect2.width);
    const y2 = Math.min(rect1.y + rect1.height, rect2.y + rect2.height);
    
    if (x2 <= x1 || y2 <= y1) {
      return 0; // No overlap
    }
    
    const overlapArea = (x2 - x1) * (y2 - y1);
    const rect1Area = rect1.width * rect1.height;
    
    return rect1Area > 0 ? overlapArea / rect1Area : 0;
  }

  /**
   * Check if rect1 is entirely contained within rect2
   */
  private isRectangleContainedWithin(rect1: {x: number, y: number, width: number, height: number}, rect2: {x: number, y: number, width: number, height: number}): boolean {
    return rect1.x >= rect2.x &&
           rect1.y >= rect2.y &&
           rect1.x + rect1.width <= rect2.x + rect2.width &&
           rect1.y + rect1.height <= rect2.y + rect2.height;
  }
}