"""LLM gateway wrapper.

Routes through OpenRouter by default. The OpenAI Chat Completions wire
format is the de-facto interop standard, so this also works against
Together, Groq, vLLM, or any OpenAI-compatible endpoint by overriding
LLM_BASE_URL. Agent code never names a specific model: the model is
selected per-call or via the LLM_MODEL env var.
"""
from __future__ import annotations

import os

from openai import OpenAI

DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
KEY_ENV = "LLM_API_KEY"
MODEL_ENV = "LLM_MODEL"
BASE_URL_ENV = "LLM_BASE_URL"


def client() -> OpenAI:
    key = os.environ.get(KEY_ENV)
    if not key:
        raise RuntimeError(f"set {KEY_ENV} in .env (OpenRouter key from https://openrouter.ai/keys)")
    base_url = os.environ.get(BASE_URL_ENV, DEFAULT_BASE_URL)
    return OpenAI(api_key=key, base_url=base_url)


def generate_strategy(
    system_prompt: str,
    user_prompt: str,
    model: str | None = None,
    max_tokens: int = 2048,
) -> str:
    """Single-turn strategy generation. Returns the model's text response.
    Strategy modules are responsible for parsing the response into Allocation.
    """
    chosen = model or os.environ.get(MODEL_ENV)
    if not chosen:
        raise RuntimeError(
            f"set {MODEL_ENV} in .env (any OpenRouter model id, e.g. "
            "'meta-llama/llama-3.3-70b-instruct', 'deepseek/deepseek-chat-v3', "
            "'qwen/qwen-2.5-72b-instruct')"
        )
    resp = client().chat.completions.create(
        model=chosen,
        max_tokens=max_tokens,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    )
    return resp.choices[0].message.content or ""
