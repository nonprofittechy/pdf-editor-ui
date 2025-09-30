const checkCanvas = () => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("canvas");
    console.log("✔︎ 'canvas' is available. Raster detectors can run locally.");
  } catch (error) {
    console.log("✖ 'canvas' is not installed or failed to load.");
    console.log("");
    console.log("Install the native prerequisites, then reinstall dependencies:");
    console.log("\nUbuntu / Debian:");
    console.log(
      "  sudo apt-get update && sudo apt-get install -y libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev pkg-config"
    );
    console.log("");
    console.log("macOS (Homebrew):");
    console.log("  brew install pkg-config cairo pango libpng jpeg giflib librsvg");
    console.log("");
    console.log("After installing prerequisites, run 'npm install' again.");
  }
};

checkCanvas();

