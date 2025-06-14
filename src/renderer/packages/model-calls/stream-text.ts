import uniqueId from 'lodash/uniqueId'
import { Message, MessageToolCallPart, ProviderOptions, StreamTextResult } from '../../../shared/types'
import { ModelInterface, OnResultChange, onResultChangeWithCancel } from '../models/types'
import { constructMessagesWithSearchResults, searchByPromptEngineering, webSearchTool } from './tools'

export async function streamText(
  model: ModelInterface,
  params: {
    messages: Message[]
    onResultChangeWithCancel: onResultChangeWithCancel
    webBrowsing?: boolean
    providerOptions?: ProviderOptions
  }
) {
  const controller = new AbortController()
  const cancel = () => controller.abort()

  let result: StreamTextResult = {
    contentParts: [],
  }

  try {
    params.onResultChangeWithCancel({ cancel }) // 这里先传递 cancel 方法
    const onResultChange: OnResultChange = (data) => {
      result = { ...result, ...data }
      params.onResultChangeWithCancel({ ...data, cancel })
    }

    // 不支持工具调用的模型，则使用prompt engineering的方式进行联网搜索
    if (params.webBrowsing && (!model.isSupportToolUse('web-browsing'))) {
      const callResult = await searchByPromptEngineering(model, params.messages, controller.signal)
      // 模型判断不需要搜索，或没有搜索结果，让模型正常回答
      if (!callResult?.searchResults?.length) {
        return model.chat(params.messages, { signal: controller.signal, onResultChange })
      }
      const toolCallPart: MessageToolCallPart = {
        type: 'tool-call',
        state: 'result',
        toolCallId: `web_search_${uniqueId()}`,
        toolName: 'web_search',
        args: { query: callResult.query },
        result: callResult,
      }
      onResultChange({ contentParts: [toolCallPart] })
      return model.chat(constructMessagesWithSearchResults(params.messages, callResult.searchResults), {
        signal: controller.signal,
        onResultChange: (data) => {
          if (data.contentParts) {
            onResultChange({ contentParts: [toolCallPart, ...data.contentParts] })
          } else {
            onResultChange(data)
          }
        },
        providerOptions: params.providerOptions,
      })
    }

    result = await model.chat(params.messages, {
      signal: controller.signal,
      onResultChange,
      tools: params.webBrowsing ? { web_search: webSearchTool } : undefined,
      providerOptions: params.providerOptions,
    })

    return result
  } catch (err) {
    console.error(err)
    // if a cancellation is performed, do not throw an exception, otherwise the content will be overwritten.
    if (controller.signal.aborted) {
      return result
    }
    throw err
  }
}
