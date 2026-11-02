// SPDX-License-Identifier: GPL-3.0-or-later
import { mount } from 'svelte'
import App from './App.svelte'
import './app.css'

export default mount(App, { target: document.getElementById('app')! })
