const target = process.env.E2E_TARGET || 'mock';
const mockBase = `http://127.0.0.1:${process.env.MOCK_PORT || 8787}`;

if (target === 'staging' && (!process.env.A_BASE_URL || !process.env.B_BASE_URL || !process.env.C_BASE_URL)) {
  throw new Error('staging 模式需要 A_BASE_URL / B_BASE_URL / C_BASE_URL');
}

export const bases = target === 'mock'
  ? { a: mockBase, b: mockBase, c: mockBase }
  : { a: process.env.A_BASE_URL, b: process.env.B_BASE_URL, c: process.env.C_BASE_URL };

export const url = (service, path) => bases[service] + path;