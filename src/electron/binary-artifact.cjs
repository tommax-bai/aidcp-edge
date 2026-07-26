'use strict';

function binaryArch(binary, platform) {
  if (platform === 'darwin' && binary.length >= 8) {
    const magic = binary.readUInt32BE(0);
    const littleEndian = magic === 0xcffaedfe;
    const bigEndian = magic === 0xfeedfacf;
    if (littleEndian || bigEndian) {
      const cpuType = littleEndian ? binary.readUInt32LE(4) : binary.readUInt32BE(4);
      if (cpuType === 0x01000007) return 'x64';
      if (cpuType === 0x0100000c) return 'arm64';
    }
  }
  if (platform === 'win32' && binary.length >= 0x40 && binary.subarray(0, 2).toString('ascii') === 'MZ') {
    const peOffset = binary.readUInt32LE(0x3c);
    if (peOffset + 6 <= binary.length && binary.subarray(peOffset, peOffset + 4).toString('binary') === 'PE\0\0') {
      const machine = binary.readUInt16LE(peOffset + 4);
      if (machine === 0x8664) return 'x64';
      if (machine === 0xaa64) return 'arm64';
    }
  }
  return 'unknown';
}

module.exports = {
  binaryArch,
};
