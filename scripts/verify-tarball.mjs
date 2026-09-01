import {
  verifyPackedDarkroomPackage,
  withPackedDarkroomPackage,
} from './package-utils.mjs';

const skipBuild = process.argv.includes('--skip-build');

await withPackedDarkroomPackage(
  async ({ metadata }) => {
    const result = await verifyPackedDarkroomPackage(metadata);
    console.log(
      `Verified @coloristic.org/darkroom tarball: ${result.fileCount} files, ` +
        `${result.packedBytes} packed bytes, ${result.unpackedBytes} unpacked bytes.`,
    );
  },
  { build: !skipBuild },
);
