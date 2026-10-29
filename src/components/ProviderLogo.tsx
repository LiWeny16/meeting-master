import ComputerRounded from '@mui/icons-material/ComputerRounded';
import assemblyai from '@lobehub/icons-static-svg/icons/assemblyai-color.svg?url';
import azure from '@lobehub/icons-static-svg/icons/azure-color.svg?url';
import claude from '@lobehub/icons-static-svg/icons/claude-color.svg?url';
import deepgram from '../assets/provider-icons/deepgram.svg?url';
import deepseek from '@lobehub/icons-static-svg/icons/deepseek-color.svg?url';
import doubao from '@lobehub/icons-static-svg/icons/doubao-color.svg?url';
import elevenlabs from '@lobehub/icons-static-svg/icons/elevenlabs.svg?url';
import gemini from '@lobehub/icons-static-svg/icons/gemini-color.svg?url';
import groq from '@lobehub/icons-static-svg/icons/groq.svg?url';
import googlecloud from '@lobehub/icons-static-svg/icons/googlecloud-color.svg?url';
import iflytekcloud from '@lobehub/icons-static-svg/icons/iflytekcloud-color.svg?url';
import lmstudio from '@lobehub/icons-static-svg/icons/lmstudio.svg?url';
import ollama from '@lobehub/icons-static-svg/icons/ollama.svg?url';
import openai from '@lobehub/icons-static-svg/icons/openai.svg?url';
import microsoft from '@lobehub/icons-static-svg/icons/microsoft-color.svg?url';
import mistral from '@lobehub/icons-static-svg/icons/mistral-color.svg?url';
import qwen from '@lobehub/icons-static-svg/icons/qwen-color.svg?url';
import volcengine from '@lobehub/icons-static-svg/icons/volcengine-color.svg?url';
import xiaomimimo from '@lobehub/icons-static-svg/icons/xiaomimimo.svg?url';

const logos: Record<string, string> = {
  deepgram,
  deepseek,
  assemblyai,
  azure,
  microsoft,
  googlecloud,
  anthropic: claude,
  claude,
  doubao,
  elevenlabs,
  gemini,
  groq,
  iflytekcloud,
  iflytek: iflytekcloud,
  lmstudio,
  mistral,
  ollama,
  openai,
  qwen,
  volcengine,
  xiaomimimo,
  mimo: xiaomimimo,
};

const monochromeLogos = new Set([deepgram, groq, lmstudio, ollama, openai, xiaomimimo]);

function logoFor(providerId: string, api: string): string | undefined {
  const key = providerId.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (/local|websocket|onion|3080/.test(key)) return undefined;
  const brand = Object.keys(logos).sort((a, b) => b.length - a.length).find((candidate) => key.includes(candidate));
  if (brand) return logos[brand];
  if (api.includes('anthropic')) return claude;
  if (api.includes('google')) return gemini;
  return undefined;
}

export function ProviderLogo({ providerId, api = '', size = 22 }: { providerId: string; api?: string; size?: number }) {
  const source = logoFor(providerId, api);
  if (!source) {
    return <ComputerRounded aria-hidden="true" sx={{ width: size, height: size, color: 'text.secondary', flex: '0 0 auto' }} />;
  }
  const mono = monochromeLogos.has(source);
  return <img className={mono ? 'provider-logo-mono' : 'provider-logo'} src={source} alt="" aria-hidden="true" width={size} height={size} style={{ width: size, height: size, objectFit: 'contain', flex: '0 0 auto' }} />;
}
