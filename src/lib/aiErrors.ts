// What to tell the user when an AI request fails, and how to fix it.
import type { AiErrorCode } from './aiApi';

export interface AiErrorInfo {
  title: string;
  /** What to do about it (null: nothing to add). */
  hint: string | null;
}

export const CLAUDE_INSTALL = 'irm https://claude.ai/install.ps1 | iex';

export function aiErrorInfo(code: AiErrorCode): AiErrorInfo {
  switch (code) {
    case 'disabled':
      return { title: 'La IA está desactivada.', hint: 'Activala en Configuración → IA (ai.enabled).' };
    case 'not-installed':
      return {
        title: 'No se encontró Claude Code (claude).',
        hint: `Instalalo desde PowerShell con «${CLAUDE_INSTALL}» (o «npm install -g @anthropic-ai/claude-code»), ejecutá «claude» una vez para iniciar sesión y volvé a intentar. Si ya está instalado en otra carpeta, indicá la ruta en Configuración → IA.`,
      };
    case 'outdated':
      return {
        title: 'Tu versión de Claude Code no admite una opción que Brisa usa para aislarlo.',
        hint: 'Actualizalo con «claude update» (o «npm install -g @anthropic-ai/claude-code@latest») y volvé a intentar.',
      };
    case 'auth':
      return {
        title: 'Claude Code no tiene una sesión iniciada.',
        hint: 'En una terminal ejecutá «claude» y usá /login (o «claude auth login»); cuando termine, volvé a intentar.',
      };
    case 'limit':
      return { title: 'Llegaste al límite de uso de tu plan o de tu cuenta.', hint: 'Esperá a que se renueve el límite, o cambiá de proveedor en Configuración → IA.' };
    case 'no-key':
      return {
        title: 'No hay una API key de Anthropic guardada.',
        hint: 'Guardala en Configuración → IA: queda en el Administrador de credenciales de Windows, nunca en settings.json.',
      };
    case 'api-key':
      return { title: 'Anthropic rechazó la API key.', hint: 'Revisala o reemplazala en Configuración → IA.' };
    case 'rate-limit':
      return { title: 'Demasiadas consultas seguidas (límite de la API).', hint: 'Esperá unos segundos y volvé a intentar.' };
    case 'overloaded':
      return { title: 'El servicio está sobrecargado.', hint: 'Probá de nuevo en unos segundos.' };
    case 'network':
      return { title: 'Sin conexión con la API de Anthropic.', hint: 'Revisá la conexión a internet o el proxy de Windows.' };
    case 'refusal':
      return { title: 'El modelo no quiso responder esta consulta.', hint: null };
    case 'timeout':
      return { title: 'La consulta tardó demasiado y se abandonó.', hint: 'Volvé a intentar; con Claude Code, revisá que «claude» funcione en una terminal.' };
    case 'cancelled':
      return { title: 'Consulta cancelada.', hint: null };
    case 'invalid':
      return { title: 'La consulta fue rechazada.', hint: 'Revisá el modelo en Configuración → IA (ai.model).' };
    case 'failed':
      return { title: 'La consulta falló.', hint: null };
  }
}
