import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';
import {
  SITE_AUTHOR,
  SITE_DEFAULT_URL,
  SITE_DESCRIPTION,
  SITE_KEYWORDS,
  SITE_NAME,
} from './src/lib/constants/site';

const siteUrl = (process.env.SITE_URL ?? SITE_DEFAULT_URL).replace(/\/$/, '');

const injectSiteMeta = (html: string): string =>
  html
    .replaceAll('%SITE_URL%', siteUrl)
    .replaceAll('%SITE_NAME%', SITE_NAME)
    .replaceAll('%SITE_DESCRIPTION%', SITE_DESCRIPTION)
    .replaceAll('%SITE_KEYWORDS%', SITE_KEYWORDS)
    .replaceAll('%SITE_AUTHOR%', SITE_AUTHOR);

const seoPlugin = (): Plugin => ({
  name: 'darkroom-seo',
  transformIndexHtml(html) {
    return injectSiteMeta(html);
  },
  closeBundle() {
    const dist = resolve(__dirname, 'dist');

    writeFileSync(
      resolve(dist, 'robots.txt'),
      ['User-agent: *', 'Allow: /', '', `Sitemap: ${siteUrl}/sitemap.xml`, ''].join('\n'),
      'utf8',
    );

    const lastmod = new Date().toISOString().slice(0, 10);
    writeFileSync(
      resolve(dist, 'sitemap.xml'),
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        '  <url>',
        `    <loc>${siteUrl}/</loc>`,
        `    <lastmod>${lastmod}</lastmod>`,
        '    <changefreq>weekly</changefreq>',
        '    <priority>1.0</priority>',
        '  </url>',
        '</urlset>',
        '',
      ].join('\n'),
      'utf8',
    );
  },
});

export default defineConfig({
  plugins: [svelte(), seoPlugin()],
  resolve: {
    alias: {
      $lib: path.resolve('./src/lib'),
    },
  },
});