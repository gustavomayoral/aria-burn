// SPDX-License-Identifier: GPL-3.0-or-later
import { mount } from 'svelte'
import App from './App.svelte'
// The shared Aria theme (BURN-28) first: app.css maps its own tokens onto it.
import '@aria/theme/fonts.css'
import '@aria/theme/theme.css'
import './app.css'

export default mount(App, { target: document.getElementById('app')! })
