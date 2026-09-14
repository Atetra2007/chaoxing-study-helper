import { deflateSync } from 'node:zlib';

export const SAMPLE_PAGE_COUNT = 31;
export const SAMPLE_WIDTH = 1023;
export const SAMPLE_HEIGHT = 1447;

// Small bitmap lettering makes page order visible without fonts or native libraries.
const font = {
  '0':['01110','10001','10011','10101','11001','10001','01110'],
  '1':['00100','01100','00100','00100','00100','00100','01110'],
  '2':['01110','10001','00001','00010','00100','01000','11111'],
  '3':['11110','00001','00001','01110','00001','00001','11110'],
  '4':['00010','00110','01010','10010','11111','00010','00010'],
  '5':['11111','10000','10000','11110','00001','00001','11110'],
  '6':['01110','10000','10000','11110','10001','10001','01110'],
  '7':['11111','00001','00010','00100','01000','01000','01000'],
  '8':['01110','10001','10001','01110','10001','10001','01110'],
  '9':['01110','10001','10001','01111','00001','00001','01110'],
  'A':['01110','10001','10001','11111','10001','10001','10001'],
  'C':['01111','10000','10000','10000','10000','10000','01111'],
  'D':['11110','10001','10001','10001','10001','10001','11110'],
  'E':['11111','10000','10000','11110','10000','10000','11111'],
  'F':['11111','10000','10000','11110','10000','10000','10000'],
  'G':['01111','10000','10000','10111','10001','10001','01111'],
  'H':['10001','10001','10001','11111','10001','10001','10001'],
  'I':['11111','00100','00100','00100','00100','00100','11111'],
  'L':['10000','10000','10000','10000','10000','10000','11111'],
  'M':['10001','11011','10101','10101','10001','10001','10001'],
  'N':['10001','11001','11001','10101','10011','10011','10001'],
  'O':['01110','10001','10001','10001','10001','10001','01110'],
  'P':['11110','10001','10001','11110','10000','10000','10000'],
  'R':['11110','10001','10001','11110','10100','10010','10001'],
  'S':['01111','10000','10000','01110','00001','00001','11110'],
  'T':['11111','00100','00100','00100','00100','00100','00100'],
  'U':['10001','10001','10001','10001','10001','10001','01110'],
  'V':['10001','10001','10001','10001','10001','01010','00100'],
  'X':['10001','10001','01010','00100','01010','10001','10001'],
  'Y':['10001','10001','01010','00100','00100','00100','00100'],
  '/':['00001','00001','00010','00100','01000','10000','10000'],
};

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const payload = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  payload.copy(result, 4);
  result.writeUInt32BE(crc32(payload), result.length - 4);
  return result;
}

export function syntheticPage(number) {
  if (!Number.isInteger(number) || number < 1 || number > SAMPLE_PAGE_COUNT) {
    throw new RangeError(`Synthetic page must be between 1 and ${SAMPLE_PAGE_COUNT}`);
  }
  const pixels = Buffer.alloc(SAMPLE_WIDTH * SAMPLE_HEIGHT * 3, 255);
  const rectangle = (x, y, width, height, color) => {
    for (let row = y; row < Math.min(y + height, SAMPLE_HEIGHT); row++) {
      for (let column = x; column < Math.min(x + width, SAMPLE_WIDTH); column++) {
        const offset = (row * SAMPLE_WIDTH + column) * 3;
        pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2];
      }
    }
  };
  const lettering = (value, x, y, scale, color) => {
    for (const letter of value) {
      const glyph = font[letter];
      if (letter !== ' ' && !glyph) throw new Error(`Unsupported fixture letter: ${letter}`);
      glyph?.forEach((row, line) => [...row].forEach((pixel, column) => {
        if (pixel === '1') rectangle(x + column * scale, y + line * scale, scale, scale, color);
      }));
      x += 6 * scale;
    }
  };
  const ink = [27, 56, 99];
  rectangle(48, 48, 927, 216, [231, 240, 253]);
  lettering('SYNTHETIC TEST PAGE', 82, 93, 7, ink);
  lettering('NO COURSE CONTENT', 82, 177, 4, ink);
  lettering(`${String(number).padStart(2, '0')} / 31`, 96, 334, 18, ink);
  lettering('LOCAL DEVELOPMENT FIXTURE', 82, 584, 5, ink);
  for (let i = 0; i < 8; i++) rectangle(82, 700 + i * 56, 420 + (number * 37 + i * 67) % 430, 12, [210, 221, 236]);
  rectangle(82, 1240, Math.round(850 * number / SAMPLE_PAGE_COUNT), 28, [64, 113, 201]);
  lettering(`PAGE ${number} / 31`, 82, 1310, 6, ink);

  const stride = SAMPLE_WIDTH * 3;
  const scanlines = Buffer.alloc((stride + 1) * SAMPLE_HEIGHT);
  for (let row = 0; row < SAMPLE_HEIGHT; row++) pixels.copy(scanlines, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SAMPLE_WIDTH, 0); header.writeUInt32BE(SAMPLE_HEIGHT, 4);
  header[8] = 8; header[9] = 2; // 8-bit RGB, no interlacing.
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
