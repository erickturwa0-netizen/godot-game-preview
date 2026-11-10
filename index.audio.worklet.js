/**************************************************************************/
/*  audio.worklet.js                                                      */
/**************************************************************************/
/*                         This file is part of:                          */
/*                             GODOT ENGINE                               */
/*                        https://godotengine.org                         */
/**************************************************************************/
/* Copyright (c) 2014-present Godot Engine contributors (see AUTHORS.md). */
/* Copyright (c) 2007-2014 Juan Linietsky, Ariel Manzur.                  */
/*                                                                        */
/* Permission is hereby granted, free of charge, to any person obtaining  */
/* a copy of this software and associated documentation files (the        */
/* "Software"), to deal in the Software without restriction, including    */
/* without limitation the rights to use, copy, modify, merge, publish,    */
/* distribute, sublicense, and/or sell copies of the Software, and to     */
/* permit persons to whom the Software is furnished to do so, subject to  */
/* the following conditions:                                              */
/*                                                                        */
/* The above copyright notice and this permission notice shall be         */
/* included in all copies or substantial portions of the Software.        */
/*                                                                        */
/* THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,        */
/* EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF     */
/* MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. */
/* IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY   */
/* CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,   */
/* TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE      */
/* SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.                 */
/**************************************************************************/

class RingBuffer {
	constructor(p_buffer, p_state, p_threads) {
		this.buffer = p_buffer;
		this.avail = p_state;
		this.threads = p_threads;
		this.rpos = 0;
		this.wpos = 0;
	}

	data_left() {
		return this.threads ? Atomics.load(this.avail, 0) : this.avail;
	}

	space_left() {
		return this.threads ? this.buffer.length - Atomics.load(this.avail, 0) : this.buffer.length - this.avail;
	}

	read(output) {
		const size = this.buffer.length;
		let from = 0;
		let to = 0;
		let left = 0;
		const avail = this.data_left();
		const limit = Math.min(output.length, avail);
		if (this.threads) {
			Atomics.add(this.avail, 0, -limit);
		} else {
			this.avail -= limit;
		}
		while (to < limit) {
			left = size - this.rpos;
			from = Math.min(left, limit - to);
			output.set(this.buffer.subarray(this.rpos, this.rpos + from), to);
			to += from;
			this.rpos += from;
			if (this.rpos === size) {
				this.rpos = 0;
			}
		}
	}

	write(p_buffer) {
		const size = this.buffer.length;
		let from = 0;
		let to = 0;
		let left = 0;
		const space = this.space_left();
		const limit = Math.min(p_buffer.length, space);
		if (this.threads) {
			Atomics.add(this.avail, 0, limit);
		} else {
			this.avail += limit;
		}
		while (to < limit) {
			left = size - this.wpos;
			from = Math.min(left, limit - to);
			this.buffer.set(p_buffer.subarray(to, to + from), this.wpos);
			to += from;
			this.wpos += from;
			if (this.wpos === size) {
				this.wpos = 0;
			}
		}
	}
}

class GodotProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.running = true;
		this.lock = null;
		this.notifier = null;
		this.output = null;
		this.output_buffer = new Float32Array();
		this.input = null;
		this.input_buffer = new Float32Array();
		this.threads = false;
		this.port.onmessage = (event) => {
			const cmd = event.data['cmd'];
			const data = event.data['data'];
			this['process_cmd'](cmd, data);
		};
	}

	process_notify() {
		if (this.notifier) {
			Atomics.add(this.notifier, 0, 1);
			Atomics.notify(this.notifier, 0);
		}
	}

	process_cmd(p_cmd, p_data) {
		if (p_cmd === 'start' && p_data) {
			const state = p_data[0];
			this.lock = state.subarray(1, 2);
			this.notifier = state.subarray(2, 3);
			const chunks = p_data[1];
			this.output = new RingBuffer(chunks[0], state.subarray(0, 1), true);
			this.input = new RingBuffer(chunks[1], state.subarray(3, 4), true);
			this.threads = true;
		} else if (p_cmd === 'stop') {
			this.running = false;
			this.output = null;
			this.input = null;
			this.lock = null;
			this.notifier = null;
		} else if (p_cmd === 'start_nothreads') {
			this.output = new RingBuffer(p_data[0], p_data[0].length, false);
		} else if (p_cmd === 'chunk') {
			this.output.write(p_data);
		}
	}

	static array_has_data(arr) {
		return arr.length && arr[0].length && arr[0][0].length;
	}

	process(inputs, outputs, parameters) {
		if (!this.running) {
			return false;
		}
		if (this.output === null) {
			return true;
		}
		const process_input = GodotProcessor.array_has_data(inputs);
		if (process_input) {
			const input = inputs[0];
			const chunk = input[0].length * input.length;
			if (this.input_buffer.length !== chunk) {
				this.input_buffer = new Float32Array(chunk);
			}
			if (!this.threads) {
				GodotProcessor.write_input(this.input_buffer, input);
				this.port.postMessage({ 'cmd': 'input', 'data': this.input_buffer });
			} else if (this.input.space_left() >= chunk) {
				GodotProcessor.write_input(this.input_buffer, input);
				this.input.write(this.input_buffer);
			}
		}
		const process_output = GodotProcessor.array_has_data(outputs);
		if (process_output) {
			const output = outputs[0];
			const chunk = output[0].length * output.length;
			if (this.output_buffer.length !== chunk) {
				this.output_buffer = new Float32Array(chunk);
			}
			if (this.output.data_left() >= chunk) {
				this.output.read(this.output_buffer);
				GodotProcessor.write_output(output, this.output_buffer);
				if (!this.threads) {
					this.port.postMessage({ 'cmd': 'read', 'data': chunk });
				}
			}
		}
		this.process_notify();
		return true;
	}

	static write_output(dest, source) {
		const channels = dest.length;
		for (let ch = 0; ch < channels; ch++) {
			for (let sample = 0; sample < dest[ch].length; sample++) {
				dest[ch][sample] = source[sample * channels + ch];
			}
		}
	}

	static write_input(dest, source) {
		const channels = source.length;
		for (let ch = 0; ch < channels; ch++) {
			for (let sample = 0; sample < source[ch].length; sample++) {
				dest[sample * channels + ch] = source[ch][sample];
			}
		}
	}
}

registerProcessor('godot-processor', GodotProcessor);
