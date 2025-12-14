/**
 * IMAGE PROCESSING WORKER
 * 
 * This worker handles image processing operations that are CPU-intensive.
 * Image filters manipulate every pixel, which can be slow in the main thread.
 * 
 * Key Concepts:
 * - Processes ImageData pixel-by-pixel
 * - Each pixel has 4 values: R, G, B, A (Red, Green, Blue, Alpha)
 * - Operations are performed on the pixel array
 * - Returns modified ImageData to main thread
 */

console.log('🖼️ Image Worker initialized!');

self.onmessage = function(e) {
    const { type, filterType, imageData } = e.data;
    
    if (type === 'APPLY_FILTER') {
        const startTime = performance.now();
        
        // Apply the requested filter
        let processedImageData;
        switch(filterType) {
            case 'grayscale':
                processedImageData = applyGrayscale(imageData);
                break;
            case 'sepia':
                processedImageData = applySepia(imageData);
                break;
            case 'invert':
                processedImageData = applyInvert(imageData);
                break;
            case 'brightness':
                processedImageData = applyBrightness(imageData, 50);
                break;
            case 'blur':
                processedImageData = applyBlur(imageData);
                break;
            case 'edge':
                processedImageData = applyEdgeDetection(imageData);
                break;
            default:
                processedImageData = imageData;
        }
        
        const endTime = performance.now();
        
        // Send processed image back to main thread
        self.postMessage({
            type: 'PROCESSED',
            imageData: processedImageData,
            time: (endTime - startTime).toFixed(2)
        });
    }
};

/**
 * GRAYSCALE FILTER
 * Convert color image to grayscale using luminance formula
 */
function applyGrayscale(imageData) {
    const data = imageData.data;
    
    for (let i = 0; i < data.length; i += 4) {
        // Luminance formula: 0.299R + 0.587G + 0.114B
        const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        data[i] = gray;       // Red
        data[i + 1] = gray;   // Green
        data[i + 2] = gray;   // Blue
        // data[i + 3] is alpha, leave unchanged
    }
    
    return imageData;
}

/**
 * SEPIA FILTER
 * Apply a warm, brownish tone (vintage photo effect)
 */
function applySepia(imageData) {
    const data = imageData.data;
    
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        
        data[i] = Math.min(255, (r * 0.393) + (g * 0.769) + (b * 0.189));
        data[i + 1] = Math.min(255, (r * 0.349) + (g * 0.686) + (b * 0.168));
        data[i + 2] = Math.min(255, (r * 0.272) + (g * 0.534) + (b * 0.131));
    }
    
    return imageData;
}

/**
 * INVERT FILTER
 * Invert all colors (negative effect)
 */
function applyInvert(imageData) {
    const data = imageData.data;
    
    for (let i = 0; i < data.length; i += 4) {
        data[i] = 255 - data[i];         // Red
        data[i + 1] = 255 - data[i + 1]; // Green
        data[i + 2] = 255 - data[i + 2]; // Blue
    }
    
    return imageData;
}

/**
 * BRIGHTNESS FILTER
 * Increase or decrease brightness
 */
function applyBrightness(imageData, adjustment) {
    const data = imageData.data;
    
    for (let i = 0; i < data.length; i += 4) {
        data[i] = Math.min(255, Math.max(0, data[i] + adjustment));
        data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + adjustment));
        data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + adjustment));
    }
    
    return imageData;
}

/**
 * BLUR FILTER
 * Simple box blur using 3x3 kernel
 */
function applyBlur(imageData) {
    const { width, height } = imageData;
    const src = imageData.data;
    const dst = new Uint8ClampedArray(src);
    
    // Box blur kernel (simple average of surrounding pixels)
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            for (let c = 0; c < 3; c++) { // RGB only, not alpha
                let sum = 0;
                
                // 3x3 kernel
                for (let ky = -1; ky <= 1; ky++) {
                    for (let kx = -1; kx <= 1; kx++) {
                        const idx = ((y + ky) * width + (x + kx)) * 4 + c;
                        sum += src[idx];
                    }
                }
                
                const idx = (y * width + x) * 4 + c;
                dst[idx] = sum / 9; // Average of 9 pixels
            }
        }
    }
    
    // Copy blurred data back
    for (let i = 0; i < src.length; i++) {
        src[i] = dst[i];
    }
    
    return imageData;
}

/**
 * EDGE DETECTION FILTER
 * Sobel operator for edge detection
 */
function applyEdgeDetection(imageData) {
    const { width, height } = imageData;
    const src = imageData.data;
    const dst = new Uint8ClampedArray(src.length);
    
    // First convert to grayscale
    const gray = new Uint8ClampedArray(width * height);
    for (let i = 0; i < src.length; i += 4) {
        const idx = i / 4;
        gray[idx] = src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114;
    }
    
    // Sobel kernels
    const sobelX = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
    const sobelY = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
    
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            let gx = 0, gy = 0;
            
            // Apply Sobel kernels
            for (let ky = -1; ky <= 1; ky++) {
                for (let kx = -1; kx <= 1; kx++) {
                    const idx = (y + ky) * width + (x + kx);
                    const kidx = (ky + 1) * 3 + (kx + 1);
                    gx += gray[idx] * sobelX[kidx];
                    gy += gray[idx] * sobelY[kidx];
                }
            }
            
            // Calculate magnitude
            const magnitude = Math.sqrt(gx * gx + gy * gy);
            const idx = (y * width + x) * 4;
            
            dst[idx] = magnitude;
            dst[idx + 1] = magnitude;
            dst[idx + 2] = magnitude;
            dst[idx + 3] = 255;
        }
    }
    
    // Copy edge data back
    for (let i = 0; i < src.length; i++) {
        src[i] = dst[i];
    }
    
    return imageData;
}

