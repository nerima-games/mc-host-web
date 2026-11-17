// mc-render 0.11 ships this queue from its input service; the host re-exports
// it so the rest of apps/web keeps its import path without a second copy.
export {
  consumeNativeInput,
  EMPTY_NATIVE_INPUT_QUEUE,
  enqueueNativeMouseButton,
  type NativeInputAction,
  type NativeInputQueueState,
} from '@nerima-games/mc-render'
