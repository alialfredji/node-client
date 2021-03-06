const pause = require('@marcopeg/utils/lib/pause')

class PlannedWorker {
    constructor (ctx, settings) {
        this.ctx = ctx

        // generic worker stuff
        this.index = settings.index
        this.name = settings.name || `${settings.queue}-default`
        this.id = `${this.name}-${this.index}`
        this.queue = settings.queue
        this.version = settings.version || 0
        this.handler = settings.handler
        this.batch = settings.batch ||  1
        this.lock = settings.lock || undefined
        this.delay = settings.delay || 250
        this.loopDelay = settings.loopDelay || this.delay
        this.batchDelay = settings.batchDelay || this.delay
        this.sleep = settings.sleep || (this.delay * 10)
        this.realTime = settings.realTime || false
        this.realTimeDelay = settings.realTimeDelay || 3600000 // 1h

        // loop maintenance
        this.isRunning = false
        this.isStopping = false
        this.hasStopped = false
        this.timer = null
    }

    start () {
        this.isRunning = true
        this.isStopping = false
        this.hasStopped = false

        // subscribe to the updates into the queue for real time management
        if (this.ctx.emitter) {
            this.ctx.emitter.addChannel(`fetchq__${this.queue}__pnd`, () => {
                if (this.timer !== null) {
                    clearTimeout(this.timer)
                    this.loop()
                }
            })
        }

        this.loop()
    }

    stop() {
        this.isRunning = false
        this.isStopping = false
        this.hasStopped = false

        // clear out emitter channel
        if (this.ctx.emitter) {
            this.ctx.emitter.removeChannel(`fetchq__${this.queue}__pnd`)
        }

        // clear out the current timer
        if (this.timer === null) {
            this.hasStopped = true
            return Promise.resolve()
        }

        return new Promise((resolve) => {
            const checkStopInterval = setInterval(() => {
                if (this.hasStopped) {
                    clearInterval(checkStopInterval)
                    resolve()
                }
            }, 500)
        })
    }

    async loop () {
        // clear out the timeout
        clearTimeout(this.timer)
        this.timer = null

        // check for termination signal
        if (!this.isRunning) {
            this.hasStopped = true
            return
        }

        // basic delay, might be extended if no documents were found
        let delay = this.loopDelay

        // iterate through the jobs bunch
        try {
            const res = await this.job()
            if (res === false) {
                this.ctx.logger.verbose(`no docs, wait ${this.sleep}`)
                delay = this.sleep
            }
        } catch (err) {
            this.ctx.logger.error(`[fetchq worker] ${err.message}`)
        } finally {
            this.timer = setTimeout(() => this.loop(), delay)
        }
    }

    async job () {
        this.ctx.logger.verbose(`[PICK] ${this.id} pick ${this.batch} documents`)
        const docs = await this.ctx.doc.pick(this.queue, this.version, this.batch, this.lock)

        if (!docs.length) {
            return false
        }

        this.ctx.logger.verbose(`job worker ${this.id}`)
        return await this.runBatch(docs)
    }

    async runBatch (docs) {
        const context = {
            worker: this,
            ctx: this.ctx,
        }

        for (let i = 0; i < docs.length; i++) {
            const doc = docs[i]
            try {
                const res = await this.handler(doc, context)
                await this.resolve(doc, res)
            } catch (err) {
                try {
                    await this.ctx.doc.reject(
                        this.queue,
                        doc.subject,
                        'worker exception', {
                            message: err.message,
                            err: JSON.stringify(err),
                        },
                        '*'
                    )
                } catch (err) {
                    this.ctx.logger.error(`[fetchq] planned worker ${this.name}: ${err.message}`)
                    this.ctx.logger.debug(err)
                }
            } finally {
                if (i < (docs.length - 1)) {
                    await pause(this.batchDelay)
                }
            }
        }
    }

    async resolve (doc, res) {
        switch (res.action) {
            case 'reschedule':
                await this.ctx.doc.reschedule(
                    this.queue,
                    doc.subject,
                    res.nextIteration,
                    res.payload
                )
                break
            case 'reject':
                await this.ctx.doc.reject(
                    this.queue,
                    doc.subject,
                    res.message,
                    res.details,
                    res.refId
                )
                break
            case 'kill':
                await this.ctx.doc.kill(
                    this.queue,
                    doc.subject,
                    res.payload
                )
                break
            case 'complete':
                await this.ctx.doc.complete(
                    this.queue,
                    doc.subject,
                    res.payload
                )
                break
            case 'drop':
                await this.ctx.doc.drop(
                    this.queue,
                    doc.subject
                )
                break
            default:
                throw new Error('unrecognised action')
        }
    }
}

module.exports = {
    PlannedWorker,
}
