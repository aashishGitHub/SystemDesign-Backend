# Web Workers Learning Examples

This folder contains educational examples demonstrating **Service Workers** and **Web Workers** in JavaScript.

## 📚 What's Inside

### 1. Service Worker Example
- **File**: `service-worker-demo/`
- **Purpose**: Demonstrates offline caching and network intercepting
- **Use Cases**: PWAs, offline functionality, caching strategies

### 2. Image Processing Worker
- **File**: `image-processing/`
- **Purpose**: Process images in background without blocking UI
- **Use Cases**: Filters, compression, manipulation

### 3. File Upload Worker
- **File**: `file-upload/`
- **Purpose**: Handle large file uploads with chunking
- **Use Cases**: Large file uploads, progress tracking, chunked uploads

### 4. Data Processing Worker
- **File**: `data-processing/`
- **Purpose**: Process large datasets without freezing the browser
- **Use Cases**: CSV parsing, data analysis, calculations

## 🚀 How to Run

1. **Start a local server** (Service Workers require HTTPS or localhost):
   ```bash
   # Option 1: Using Python
   python3 -m http.server 8000
   
   # Option 2: Using Node.js
   npx serve
   
   # Option 3: Using PHP
   php -S localhost:8000
   ```

2. **Open in browser**:
   ```
   http://localhost:8000
   ```

3. **Navigate** to individual examples from the main page

## 📖 Key Differences

### Service Worker vs Web Worker

| Feature | Service Worker | Web Worker |
|---------|---------------|------------|
| **Purpose** | Network proxy, caching | Background computations |
| **Lifecycle** | Independent of page | Tied to page |
| **Scope** | Can control multiple pages | Single page only |
| **Network** | Can intercept requests | Cannot intercept requests |
| **Cache API** | Full access | Limited access |
| **Use Case** | PWAs, offline apps | Heavy computations |

## 🎓 Learning Path

1. Start with **Data Processing Worker** (simplest)
2. Move to **Image Processing Worker** (more practical)
3. Try **File Upload Worker** (real-world scenario)
4. Finally explore **Service Worker** (most complex)

## 📝 Notes

- All examples are self-contained and heavily commented
- Check browser console for debug messages
- Service Workers require HTTPS (except on localhost)
- Web Workers cannot access DOM directly

## 🔗 Resources

- [MDN Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API)
- [MDN Service Workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
- [Can I Use - Service Workers](https://caniuse.com/serviceworkers)

