import { LUT_SIZE } from '../processing/lut';

const sanitizeTitle = (title: string): string =>
  title.replace(/["\r\n]/g, ' ').trim() || 'Coloristic Darkroom Grade';

/** Formats a 64³ LUT as a standard .cube file (Resolve, Premiere, FCP). */
export const formatCubeFile = (
  lut: Uint8Array,
  title: string,
  comments: string[] = [],
): string => {
  const lines: string[] = [
    `TITLE "${sanitizeTitle(title)}"`,
    `LUT_3D_SIZE ${LUT_SIZE}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
  ];

  for (const comment of comments) {
    const trimmed = comment.trim();
    if (trimmed) lines.push(`# ${trimmed}`);
  }

  lines.push('');

  for (let b = 0; b < LUT_SIZE; b += 1) {
    for (let g = 0; g < LUT_SIZE; g += 1) {
      for (let r = 0; r < LUT_SIZE; r += 1) {
        const offset = (r + g * LUT_SIZE + b * LUT_SIZE * LUT_SIZE) * 3;
        const red = (lut[offset] / 255).toFixed(6);
        const green = (lut[offset + 1] / 255).toFixed(6);
        const blue = (lut[offset + 2] / 255).toFixed(6);
        lines.push(`${red} ${green} ${blue}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
};

export const downloadTextFile = (content: string, filename: string): void => {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};