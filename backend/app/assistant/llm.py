"""OpenAI chat-completions client for the assistant: OpenAI-compatible endpoints (incl. Ollama) or Azure."""

from openai import AsyncAzureOpenAI, AsyncOpenAI

from app.core.config import get_settings


class AssistantUnavailable(Exception):
    pass


def provider() -> str:
    return get_settings().llm_provider.lower()


def model_label() -> str | None:
    s = get_settings()
    return s.llm_model or None if provider() != "offline" else None


def client() -> AsyncOpenAI:
    s = get_settings()
    if not s.llm_model:
        raise AssistantUnavailable("LLM_MODEL is not configured.")
    if provider() == "azure":
        if not (s.azure_openai_endpoint and s.llm_api_key):
            raise AssistantUnavailable("AZURE_OPENAI_ENDPOINT and LLM_API_KEY are required for the Azure provider.")
        return AsyncAzureOpenAI(azure_endpoint=s.azure_openai_endpoint, api_key=s.llm_api_key,
                                api_version=s.azure_openai_api_version, timeout=s.llm_timeout_s, max_retries=2)
    if provider() == "openai":
        # Ollama ignores the key but the SDK requires one
        return AsyncOpenAI(base_url=s.llm_base_url, api_key=s.llm_api_key or "not-needed",
                           timeout=s.llm_timeout_s, max_retries=2)
    raise AssistantUnavailable(f"Unknown LLM provider “{s.llm_provider}”.")
