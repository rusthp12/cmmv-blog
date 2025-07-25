import {
    createServer, loadEnv,
    ViteDevServer
} from 'vite';

import { transformHtmlTemplate } from '@unhead/vue/server';
import { useSettingsStore } from './src/store/settings.js';

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import * as crypto from 'node:crypto';
import * as mime from 'mime-types';

const env = loadEnv(process.env.NODE_ENV || 'development', process.cwd(), 'VITE');
const fileCache = new Map<string, { buffer: Buffer, etag: string, mtime: number }>();

interface PageCacheEntry {
    html: string;
    compressedVersions: {
        gzip?: Buffer;
        br?: Buffer;
        uncompressed: string;
    };
    timestamp: number;
    headers: Record<string, string>;
}

const pageCache = new Map<string, PageCacheEntry>();
const PAGE_CACHE_DURATION = 30 * 60 * 1000;

/**
 * Clean expired page cache entries
 */
const cleanExpiredPageCache = () => {
    const now = Date.now();
    for (const [key, entry] of pageCache.entries()) {
        if (now - entry.timestamp > PAGE_CACHE_DURATION) {
            pageCache.delete(key);
        }
    }
};

/**
 * Check if a page cache entry is still valid
 */
const isPageCacheValid = (key: string): boolean => {
    const entry = pageCache.get(key);
    if (!entry) return false;

    const now = Date.now();
    return (now - entry.timestamp) < PAGE_CACHE_DURATION;
};

/**
 * Generate cache key from request
 */
const generateCacheKey = (url: string, userAgent?: string): string => {
    const isMobile = userAgent?.toLowerCase().includes('mobile') ? 'mobile' : 'desktop';
    return `${url}:${isMobile}`;
};

/**
 * Clear all page cache
 */
const clearPageCache = () => {
    const cacheSize = pageCache.size;
    pageCache.clear();
    console.log(`🗑️ Page cache cleared. Removed ${cacheSize} entries.`);
};

/**
 * Get cache statistics
 */
const getCacheStats = () => {
    const now = Date.now();
    let validEntries = 0;
    let expiredEntries = 0;

    for (const [key, entry] of pageCache.entries()) {
        if (now - entry.timestamp > PAGE_CACHE_DURATION) {
            expiredEntries++;
        } else {
            validEntries++;
        }
    }

    return {
        total: pageCache.size,
        valid: validEntries,
        expired: expiredEntries
    };
};

const compressHtml = (html: string, acceptEncoding: string = ''): { data: Buffer | string, encoding: string | null } => {
    if (acceptEncoding.includes('br')) {
        return {
            data: zlib.brotliCompressSync(html),
            encoding: 'br'
        };
    } else if (acceptEncoding.includes('gzip')) {
        return {
            data: zlib.gzipSync(html),
            encoding: 'gzip'
        };
    }

    return {
        data: html,
        encoding: null
    };
};

const compressFile = (buffer: Buffer, acceptEncoding: string = ''): { data: Buffer, encoding: string | null } => {
    if (acceptEncoding.includes('br')) {
        return {
            data: zlib.brotliCompressSync(buffer),
            encoding: 'br'
        };
    } else if (acceptEncoding.includes('gzip')) {
        return {
            data: zlib.gzipSync(buffer),
            encoding: 'gzip'
        };
    }

    return {
        data: buffer,
        encoding: null
    };
};

const serveStaticFile = async (req: http.IncomingMessage, res: http.ServerResponse, filePath: string): Promise<boolean> => {
    const url = req.url || '/';
    const acceptEncoding = req.headers['accept-encoding'] || '';
    const ifNoneMatch = req.headers['if-none-match'] || '';

    try {
        if (!fs.existsSync(filePath))
            return false;

        const stats = fs.statSync(filePath);

        if (!stats.isFile())
            return false;

        const mtime = stats.mtime.getTime();
        let cacheEntry = fileCache.get(filePath);

        let etag: string;
        let buffer: Buffer;

        if (cacheEntry && cacheEntry.mtime === mtime) {
            buffer = cacheEntry.buffer;
            etag = cacheEntry.etag;
        } else {
            buffer = fs.readFileSync(filePath);
            etag = crypto.createHash('md5').update(buffer).digest('hex');
            fileCache.set(filePath, { buffer, etag, mtime });
        }

        const contentType = mime.lookup(filePath) || 'application/octet-stream';

        if (ifNoneMatch === etag) {
            res.writeHead(304, {
                'ETag': etag
            });
            res.end();
            return true;
        }

        res.setHeader('Content-Type', contentType);
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', `public, max-age=900`);

        const compressibleTypes = ['text/', 'application/javascript', 'application/json', 'image/svg+xml', 'application/xml'];
        const isCompressible = compressibleTypes.some(type => contentType.includes(type));

        if (isCompressible) {
            const compressed = compressFile(buffer, acceptEncoding as string);

            if (compressed.encoding) {
                res.setHeader('Content-Encoding', compressed.encoding);
                res.setHeader('Vary', 'Accept-Encoding');
            }

            res.end(compressed.data);
        } else {
            res.end(buffer);
        }

        return true;
    } catch (error) {
        console.error(`Error serving ${filePath}:`, error);
        return false;
    }
};

let serverInstance: http.Server | null = null;

async function bootstrap() {
    const isDev = process.env.NODE_ENV !== 'production';

    const vite = await createServer({
        server: {
            middlewareMode: true,
            hmr: isDev ? true : false
        },
        appType: 'custom'
    });

    const themesDir = path.resolve(process.cwd(), 'src');
    const themeFolders = fs.readdirSync(themesDir)
        .filter(folder => folder.startsWith('theme-') && fs.statSync(path.join(themesDir, folder)).isDirectory());

    const themes: Record<string, any> = {};
    for (const folder of themeFolders) {
        const themeJsonPath = path.join(themesDir, folder, 'theme.json');
        if (fs.existsSync(themeJsonPath)) {
            try {
                const themeData = JSON.parse(fs.readFileSync(themeJsonPath, 'utf-8'));
                themes[`./${folder}/theme.json`] = {
                    namespace: folder.replace('theme-', ''),
                    name: themeData.name,
                    description: themeData.description,
                    author: themeData.author,
                    version: themeData.version,
                    preview: `${env.VITE_WEBSITE_URL}${themeData.preview}`
                };
            } catch (error) {
                console.error(`Error loading theme from ${themeJsonPath}:`, error);
            }
        }
    }

    const server = http.createServer(async (req, res) => {
        const url = req.url || '';
        const acceptEncoding = req.headers['accept-encoding'] || '';

        if (url === '/themas' && req.method === 'GET') {
            res.setHeader('Content-Type', 'application/json');

            try {
                const themeList = Object.keys(themes).map(path => {
                    return themes[path];
                });

                res.statusCode = 200;
                res.end(JSON.stringify(themeList));
                return;
            } catch (error) {
                res.statusCode = 500;
                res.end(JSON.stringify([]));
                return;
            }
        }

        if (url === '/cache/clear' && req.method === 'POST') {
            const authHeader = req.headers.authorization || '';
            const expectedAuth = `Bearer ${env.VITE_SIGNATURE}`;

            if (authHeader !== expectedAuth) {
                res.statusCode = 401;
                res.setHeader('Content-Type', 'text/plain');
                res.end('Unauthorized');
                return;
            }

            clearPageCache();
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true, message: 'Cache cleared successfully' }));
            return;
        }

        if (url === '/cache/stats' && req.method === 'GET') {
            const authHeader = req.headers.authorization || '';
            const expectedAuth = `Bearer ${env.VITE_SIGNATURE}`;

            if (authHeader !== expectedAuth) {
                res.statusCode = 401;
                res.setHeader('Content-Type', 'text/plain');
                res.end('Unauthorized');
                return;
            }

            const stats = getCacheStats();
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(stats));
            return;
        }

        if (url === '/set-thema' && req.method === 'POST') {
            const authHeader = req.headers.authorization || '';
            const expectedAuth = `Bearer ${env.VITE_SIGNATURE}`;

            if (authHeader !== expectedAuth) {
                res.statusCode = 401;
                res.setHeader('Content-Type', 'text/plain');
                res.end('Unauthorized');
                return;
            }

            let body = '';
            req.on('data', chunk => {
                body += chunk.toString();
            });

            req.on('end', async () => {
                try {
                    const { theme } = JSON.parse(body);

                    if (!theme) {
                        res.statusCode = 400;
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify({
                            success: false,
                            error: 'Theme name is required'
                        }));
                        return;
                    }

                    const themeExists = Object.keys(themes).some(path => {
                        const themeName = path.match(/\.\/theme-([^/]+)\/theme\.json/)?.[1] || '';
                        return themeName === theme;
                    });

                    if (!themeExists) {
                        res.statusCode = 404;
                        res.setHeader('Content-Type', 'text/plain');
                        res.end('Theme not found');
                        return;
                    }

                    const settingsStore = useSettingsStore();
                    const settings = await fetch(`${env.VITE_API_URL}/settings`);
                    const settingsData = await settings.json();
                    settingsData["blog.theme"] = theme;
                    settingsStore.setSettings(settingsData);
                    console.log("Theme set successfully:", theme);

                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'text/plain');
                    res.end('Theme set successfully. Server will restart to apply changes.');

                    setTimeout(() => {
                        console.log(`🔄 Restarting server to apply new theme: ${theme}`);

                        if (serverInstance) {
                            serverInstance.close();
                            console.log('Server closed. Starting a new instance...');
                            bootstrap();
                        }
                    }, 500);
                } catch (error) {
                    res.statusCode = 400;
                    res.setHeader('Content-Type', 'text/plain');
                    res.end('Invalid request body');
                }
            });

            return;
        }

        if (url.startsWith('/assets/')) {
            const assetPath = path.resolve('dist', '.' + url);
            const served = await serveStaticFile(req, res, assetPath);
            if (served) return;
        }

        if (url !== '/' && !url.includes('?') && /\.\w+$/.test(url)) {
            const staticPath = path.resolve('dist', '.' + url);
            const served = await serveStaticFile(req, res, staticPath);
            if (served) return;
        }

        let template = '';
        let render: (url: string) => Promise<any>;

        if (process.env.NODE_ENV === 'production') {
            template = fs.readFileSync(path.resolve('dist/index.html'), 'utf-8');
            const mod = await (new Function('return import("./entry-server.js")')());
            render = mod.render;
        } else if(vite) {
            template = fs.readFileSync(path.resolve('index.html'), 'utf-8');
            const { render: devRender } = await vite.ssrLoadModule('/src/entry-server.ts');
            render = devRender;
        }

        vite?.middlewares(req, res, async () => {
            try {
                if (/\.\w+$/.test(url)) {
                    res.statusCode = 404;
                    return res.end(`Not found: ${url}`);
                }

                cleanExpiredPageCache();
                const userAgent = req.headers['user-agent'] || '';
                const cacheKey = generateCacheKey(url, userAgent);

                if (isPageCacheValid(cacheKey)) {
                    const cachedEntry = pageCache.get(cacheKey);
                    if (cachedEntry) {
                        //console.log(`💾 Cache HIT: ${url}`);

                        Object.entries(cachedEntry.headers).forEach(([key, value]) => {
                            res.setHeader(key, value);
                        });

                        let data: Buffer | string;
                        let encoding: string | null = null;

                        if (acceptEncoding.includes('br') && cachedEntry.compressedVersions.br) {
                            data = cachedEntry.compressedVersions.br;
                            encoding = 'br';
                        } else if (acceptEncoding.includes('gzip') && cachedEntry.compressedVersions.gzip) {
                            data = cachedEntry.compressedVersions.gzip;
                            encoding = 'gzip';
                        } else {
                            data = cachedEntry.compressedVersions.uncompressed;
                        }

                        if (encoding)
                            res.setHeader('Content-Encoding', encoding);

                        res.end(data);
                        return;
                    }
                }

                //console.log(`🔄 Cache MISS: ${url} - Processing SSR...`);

                template = await vite.transformIndexHtml(url, template);

                const {
                    html: appHtml, head, metadata, redirect,
                    piniaState, settings, posts, prefetchCache
                } = await render(url);

                const piniaScript = `\n<script>window.__PINIA__ = ${JSON.stringify(piniaState).replace(/</g, '\\u003c')}</script>`;

                if (redirect) {
                    res.writeHead(301, { Location: redirect });
                    return res.end();
                }

                globalThis.__SSR_DATA__ = { ...globalThis.__SSR_DATA__, posts };

                const ssrData = { ...globalThis.__SSR_DATA__, prefetchCache };
                const serializedData = JSON.stringify(ssrData).replace(/</g, '\\u003c');
                const dataScript = `<script>window.__CMMV_DATA__ = ${serializedData};</script>${piniaScript}`;

                template = await transformHtmlTemplate(head, template.replace(`<div id="app"></div>`, `<div id="app">${appHtml}</div>`));

                template = template.replace("<analytics />", settings["blog.analyticsCode"] || "").replace("<analytics>", settings["blog.analyticsCode"] || "");
                template = template.replace("<custom-js />", settings["blog.customJs"] || "").replace("<custom-js>", settings["blog.customJs"] || "");
                template = template.replace("<custom-css />", settings["blog.customCss"] || "").replace("<custom-css>", settings["blog.customCss"] || "");

                if (process.env.NODE_ENV === 'production') {
                    template = template.replace(/<script[^>]*src="\/@vite\/client"[^>]*><\/script>/g, '');
                    template = template.replace(/<script[^>]*type="[^"]*"[^>]*src="\/@vite\/client"[^>]*><\/script>/g, '');
                }

                for(const key in metadata)
                    template = template.replace(`{${key}}`, metadata[key]);

                const responseHeaders = {
                    'Content-Type': 'text/html',
                    'Cache-Control': 'public, max-age=900'
                };

                Object.entries(responseHeaders).forEach(([key, value]) => {
                    res.setHeader(key, value);
                });

                template = await transformHtmlTemplate(head, template.replace(`</title>`, `</title>${dataScript}`));

                // Pre-compress content for cache storage
                const gzipCompressed = zlib.gzipSync(template);
                const brotliCompressed = zlib.brotliCompressSync(template);

                pageCache.set(cacheKey, {
                    html: template,
                    compressedVersions: {
                        gzip: gzipCompressed,
                        br: brotliCompressed,
                        uncompressed: template
                    },
                    timestamp: Date.now(),
                    headers: responseHeaders
                });

                const compressed = compressHtml(template, acceptEncoding as string);

                if (compressed.encoding)
                    res.setHeader('Content-Encoding', compressed.encoding);

                res.end(compressed.data);
            } catch (e) {
                vite.ssrFixStacktrace(e as Error);
                res.statusCode = 500;
                res.end((e as Error).message);
            }
        });
    });

    const port = env.VITE_SSR_PORT || 5001;

    // @ts-ignore
    serverInstance = server.listen(port, "0.0.0.0", () => {
        console.log(`🚀 SSR server running at http://localhost:${port}`);
    });
}

setTimeout(bootstrap, 4000);
