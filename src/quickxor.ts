/* OneDrive's quickXorHash: a 160-bit shifting XOR of the content with the
 * length XORed into the tail, base64 encoded. Implemented from Microsoft's
 * published reference; OneDrive reports it for every file on both personal
 * and business accounts, so it is the hash the engine compares against. */

const WIDTH = 160;
const SHIFT = 11;

export function quickXorHash(bytes: ArrayBuffer): string {
	const data = new Uint8Array(bytes);
	const cells = new Uint8Array(WIDTH / 8 + 1); // one spare byte for bit spill
	let shiftSoFar = 0;
	for (let i = 0; i < data.length; i++) {
		const bitPos = shiftSoFar % WIDTH;
		const bytePos = bitPos >> 3;
		const bitOff = bitPos & 7;
		const v = data[i];
		cells[bytePos] ^= (v << bitOff) & 0xff;
		if (bytePos + 1 < cells.length) cells[bytePos + 1] ^= v >> (8 - bitOff);
		else cells[0] ^= v >> (8 - bitOff);
		shiftSoFar = (shiftSoFar + SHIFT) % WIDTH;
	}
	// fold the spare byte back into the front, as the reference does
	cells[0] ^= cells[WIDTH / 8];
	const out = cells.slice(0, WIDTH / 8);
	// XOR the little-endian content length into the last 8 bytes
	let len = data.length;
	for (let i = 0; i < 8; i++) {
		out[WIDTH / 8 - 8 + i] ^= len & 0xff;
		len = Math.floor(len / 256);
	}
	let s = "";
	for (const b of out) s += String.fromCharCode(b);
	return btoa(s);
}
