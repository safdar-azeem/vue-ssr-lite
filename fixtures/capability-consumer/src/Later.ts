import { defineComponent, h } from 'vue'
import './later.css'
export default defineComponent({ setup: () => () => h('main', 'Unrelated later route') })
