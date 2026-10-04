// Bun's fetch accepts `timeout: false` to turn off its default response
// timeout (300 s). bun-types does not declare it; declare it so `tsc` accepts
// it in a RequestInit (the runtime handles it).
declare global {
	interface RequestInit {
		timeout?: boolean;
	}
}

export {};
