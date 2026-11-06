// SPDX-License-Identifier: GPL-3.0-or-later
// Web Worker for SVG import (BURN-53): reads the SVG and makes its jobs off the UI thread (svg-work.ts).

import { createHandler, type SvgRequest } from './svg-work.ts'

const handle = createHandler()
const scope = self as unknown as { onmessage: ((e: MessageEvent<SvgRequest>) => void) | null; postMessage(message: unknown): void }
scope.onmessage = (e) => scope.postMessage(handle(e.data))
