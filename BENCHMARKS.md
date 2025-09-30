# PDF Field Detection Benchmarking and Improvement Plan

This document outlines the plan for benchmarking and improving the performance of PDF field detection.

## 1. Overview

The goal is to improve the accuracy of detecting form fields in PDF documents. The current approach uses a set of heuristics, but we can improve it by adding more detection methods and creating a framework for evaluating them against a ground truth dataset.

## 2. Plan

### 2.1. Benchmarking Framework

1.  **Dataset:** We will use the PDF files in the `/test` directory as our dataset. The ground truth for field locations and types will be stored in corresponding `.groundtruth.json` files.
2.  **Evaluation Script:** We will use and enhance the scripts in `/benchmarks/detection` to:
    *   Load a PDF and its ground truth data.
    *   Run one or more detection algorithms on the PDF.
    *   Compare the detected fields with the ground truth.
    *   Calculate and report metrics (e.g., precision, recall, F1-score).
3.  **Metrics:**
    *   **Precision:** (True Positives) / (True Positives + False Positives)
    *   **Recall:** (True Positives) / (True Positives + False Negatives)
    *   **F1-Score:** 2 * (Precision * Recall) / (Precision + Recall)

### 2.2. Detection Strategies

We will implement and evaluate several detection strategies:

1.  **Raster Heuristics (Baseline):** The existing `rasterHeuristics` detector will serve as our baseline.
2.  **Text-based Markers:**
    *   Detect `____` for text fields.
    *   Detect `[ ]` and `( )` for checkboxes.
3.  **Rule-based Logic:**
    *   Fields should not overlap with existing text.
    *   Fields should align with text labels (e.g., to the right of a colon).
4.  **Regular Expressions:** Use regex to find common field labels (e.g., "Name:", "Address:", "Date:").
5.  **Image-based Detection:**
    *   Use image processing to find rectangular boxes.
    *   This can be a more advanced step, potentially using a library like OpenCV.

### 2.3. Roadmap

1.  **Phase 1: Baseline Benchmark:**
    *   Flesh out the evaluation script in `benchmarks/detection/evaluate.ts`.
    *   Run the baseline `rasterHeuristics` detector against the entire dataset.
    *   Document the initial performance in this file.
2.  **Phase 2: Implement and Evaluate New Detectors:**
    *   Implement the text-based marker and rule-based detectors.
    *   Benchmark each new detector individually.
3.  **Phase 3: Hybrid Strategies:**
    *   Create a "meta" detector that combines the results of multiple detectors.
    *   Experiment with different weighting and merging strategies.
    *   Benchmark the hybrid detectors.
4.  **Phase 4: Continuous Improvement:**
    *   Analyze the errors of the best-performing detector.
    *   Add new heuristics or refine existing ones based on the analysis.
    *   Continuously update the benchmarks and documentation.

## 3. Progress and Results

*(This section will be updated as we make progress.)*
