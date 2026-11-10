// Godot audio position worklet (minimal)
class GodotPositionProcessor extends AudioWorkletProcessor {
  process() { return true; }
}
registerProcessor('godot-position-processor', GodotPositionProcessor);
