import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { register } from './plugin.ts';

export default function plugin(bb: BbPluginApi): void {
  register(bb);
}
