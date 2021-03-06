'use strict'

const Endpoint = require('../classes/Endpoint.class')
const Headers = require('../classes/Headers.class')
const logr = require('@everymundo/simple-logr')
// const { addQueryToPath } = require('../lib/add-query-to-path')
const { simulatedResponse } = require('../lib/simulate-response')
const buildResponse = require('./build-response')
// const { setResTxt } = require('../lib/set-response-text')
const { getProperDataFromInputData } = require('../lib/get-data-from-xdata')
const { setHeaders } = require('../lib/set-headers')

const SIMULATE = +process.env.SIMULATE
const MAX_RETRY_ATTEMPTS = Math.abs(process.env.MAX_RETRY_ATTEMPTS) || 3
const RETRY_TIMEOUT_MS = process.env.RETRY_TIMEOUT_MS && Math.abs(process.env.RETRY_TIMEOUT_MS)
const REQUEST_TIMEOUT_MS = process.env.REQUEST_TIMEOUT_MS && Math.abs(process.env.REQUEST_TIMEOUT_MS)

const writeMethods = new Set(['PUT', 'PATCH', 'POST'])

const getEndpoint = (endpoint) => {
  if (!endpoint) {
    throw new Error('EM: INVALID ENDPOINT')
  }

  if (!(endpoint instanceof Endpoint)) {
    return new Endpoint(endpoint)
  }

  return endpoint
}

const getHeaders = (endpoint, options, data, compress) => {
  const headers = (options && options.headers && new Headers(options.headers).toObject()) ||
    endpoint.headers.toObject()

  return setHeaders(headers, data, compress)
}

const readStreamPromise = (response) => new Promise((resolve, reject) => {
  const buffers = []

  response
    .on('data', (chunk) => { buffers.push(chunk) })
    .on('end', () => { resolve(Buffer.concat(buffers)) })
    .on('error', reject)
})

const promiseDataTo = (_endpoint, inputData, options = {}) => new Promise((resolve, reject) => {
  const endpoint = getEndpoint(_endpoint)
  const {
    query,
    // endpoint: url,
    method = options.method || 'POST',
    maxRetry = MAX_RETRY_ATTEMPTS,
    timeout = REQUEST_TIMEOUT_MS,
    compress = false
  } = endpoint

  // An object of options to indicate where to post to
  // const data = typeof xData === 'string' ? xData : JSON.stringify(xData),
  const data = getProperDataFromInputData(inputData, compress)
  const start = new Date()
  const headers = getHeaders(endpoint, options, data, compress)

  if (SIMULATE) {
    return resolve(simulatedResponse(endpoint, inputData, headers, compress, start))
  }

  const requestOptions = {
    host: endpoint.host,
    port: endpoint.port,
    query,
    // path: query ? addQueryToPath(query, endpoint.path) : endpoint.path,
    path: endpoint.path,
    method,
    headers,
    agent: endpoint.agent
  }

  let attempt = 1

  const post = () => {
    const stats = buildResponse(endpoint, inputData, headers, compress, start, attempt)

    const request = endpoint.http.request(requestOptions, async (res) => {
      stats.end = Date.now()
      stats.code = res.statusCode
      stats.responseHeaders = res.headers
      stats.responseBuffer = await readStreamPromise(res)

      if (res.statusCode === 400) {
        logr.error({ resTxt: stats.responseText })
        const err = new Error('400 Status')
        err.stats = stats

        return reject(err)
      }

      if (res.statusCode > 400) {
        logr.error({ resTxt: stats.responseText })
        return tryAgain(`Status Code: ${res.statusCode}`, stats)
      }

      if (res.statusCode > 299) {
        stats.err = new Error(`{"Response": ${stats.responseText}, "statusCode": ${res.statusCode}, "data": ${data}}`)
        return resolve(stats)
      }

      return resolve(stats)
    })
      .on('error', (error) => {
        logr.error('http.request', error)
        stats.err = error
        stats.code = 599
        stats.end = Date.now()

        // tryAgain(err, errorStats)
        tryAgain(error, stats)
      })

    if (timeout != null) {
      if (Number.isNaN(+timeout)) {
        throw new Error(`timeout param is not a number [${timeout}]`)
      }

      request.on('socket', (socket) => {
        socket.on('timeout', () => {
          request.abort()
        })
        socket.setTimeout(timeout)
      })
    }

    // post the data
    if (writeMethods.has(method.toUpperCase())) {
      request.write(data)
    }

    request.end()
  }

  function tryAgain (error, stats) {
    logr.error('tryAgain: attempt', attempt, 'has failed.', endpoint.href, error)
    if (attempt < maxRetry) {
      return setTimeout(() => { post(++attempt) }, 500)
    }

    const err = error instanceof Error ? error : new Error(error)
    err.message = `tryAgain has exceeded max delivery attempts (${attempt}):${err.message}`
    logr.error(err.message)
    stats.err = err
    reject(stats)
  }

  post()
})

module.exports = {
  getEndpoint,
  promiseDataTo,
  MAX_RETRY_ATTEMPTS,
  RETRY_TIMEOUT_MS,
  loadedAt: new Date(),
  getDataFromXData: getProperDataFromInputData
}
