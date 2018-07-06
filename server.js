const express = require('express');
const compression = require('compression');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const helmet = require('helmet');
const request = require('request');
const initPuppeteerPool = require('./modules/pool');

var isProduction = process.env.NODE_ENV === 'production';
var PORT = isProduction ? '/tmp/nginx.socket' : 8080;
var callbackFn = () => {
    if (isProduction) {
        fs.closeSync(fs.openSync('/tmp/app-initialized', 'w'));
    }

    console.log(`Listening on ${PORT}`);
};

var linkBase = isProduction ? 'https://unblocker-webapp.herokuapp.com' : `http://127.0.0.1:${PORT}`;
var RENDER_CACHE = require('./modules/cacheEngine')(isProduction);

const pool = initPuppeteerPool({
    puppeteerArgs: {
        userDataDir: path.join(__dirname, 'tmp'),
        ignoreHTTPSErrors: true,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--mute-audio',
            '--hide-scrollbars'
        ]
    }
});

const render = async ({ url, shouldScroll }) => {
    return new Promise((result, reject) => {
        pool.use(async browser => {
            var page = await browser.newPage();

            page.on('dialog', async dialog => await dialog.dismiss());
            page.setDefaultNavigationTimeout(15000);

            await page.setViewport({
                width: 1280,
                height: 720
            });
            await page.emulateMedia('screen');

            try {
                await page.goto(url, {
                    waitUntil: 'networkidle0',
                    timeout: 60000
                });

                await page.evaluate(async ({ linkBase }) => {
                    await new Promise(resolve => {
                        var links = document.querySelectorAll('a[href]');

                        for (let i = 0; i < links.length; i++) {
                            try {
                                if (/^(?:http[s]?|\/)/.test(links[i].href)) {
                                    links[i].href = `${linkBase}?url=${new URL(links[i].href, location.href).href}`;
                                }

                            } catch (err) {
                                continue;
                            }
                        }

                        return resolve(true);
                    });

                }, { linkBase });

                if (shouldScroll) {
                    await page.evaluate(async () => {
                        await new Promise(resolve => {
                            var offset = -100;
                            var pageScroll = () => {
                                window.scrollBy(0, 50);

                                if (window.pageYOffset === offset) {
                                    return resolve(true);
                                }

                                offset = window.pageYOffset;
                                scrolldelay = setTimeout(pageScroll, 50);
                            };

                            pageScroll();
                        });
                    });
                }

                var output = path.join(__dirname, 'tmp', crypto.randomBytes(20).toString('hex') + '.pdf');

                await page.pdf({
                    path: output,
                    format: 'A4',
                    printBackground: true
                });

                page.close();

                return result({ pdfDestination: output });

            } catch (err) {
                return result({ pdfDestination: null });
            }
        });
    });
};

const app = express();
app.enable("trust proxy");
app.use(helmet());
app.use(compression());
app.use('/static', express.static(path.join(__dirname, 'static')));

app.get('/', async (req, res) => {
    if (req.query.url && /http[s]?:\/\/(?:[a-zA-Z]|[0-9]|[$-_@.&+]|[!*\(\),]|(?:%[0-9a-fA-F][0-9a-fA-F]))+/.test(req.query.url)) {
        let keyExists = await RENDER_CACHE.hasKey(req.query.url);

        if (keyExists) {
            let { entryStillValid, entry } = await new Promise(async resolve => {
                let entry = await RENDER_CACHE.getKey(req.query.url);

                if (!entry) {
                  RENDER_CACHE.deleteKey(req.query.url);
                  return resolve({ entryStillValid: false, entry: null });
                }

                request({
                    method: 'HEAD',
                    uri: entry
                },
                (err, httpResponse, body) => {
                    if (err || httpResponse.statusCode !== 200) {
                        RENDER_CACHE.deleteKey(req.query.url);
                        return resolve({ entryStillValid: false, entry: null });
                    }

                    return resolve({ entryStillValid: true, entry: entry });
                });
            });

            if (entryStillValid) {
                return res.redirect(`/view?pdf=${entry}`);
            }
        }

        let shouldScroll = (req.query.shouldScroll && /^true$/.test(req.query.shouldScroll));
        let { pdfDestination } = await render({ url: req.query.url, shouldScroll: shouldScroll });

        if (pdfDestination) {
            let formPayload = {
                'files[]': fs.createReadStream(pdfDestination)
            };

            let { failed, uploadResult } = await new Promise(resolve => {
                    request({
                        method: 'POST',
                        uri: 'https://rokket.space/upload',
                        formData: formPayload
                    },
                    (err, httpResponse, body) => {
                        if (err || httpResponse.statusCode !== 200) {
                            return resolve({
                                failed: true,
                                uploadResult: {
                                    success: false
                                }
                            });
                        }

                        return resolve({
                            failed: false,
                            uploadResult: JSON.parse(body)
                        });
                    });
            });

            if (!failed && uploadResult.success) {
                fs.unlinkSync(pdfDestination);

                let uploadUrl = uploadResult.files[0].url;
                RENDER_CACHE.setKey(req.query.url, uploadUrl);

                return res.redirect(`/view?pdf=${uploadUrl}`);

            } else {
                fs.unlinkSync(pdfDestination);

                res.set('Content-Type', 'text/html');
                return res.send(Buffer.from("<h1>Failed to upload result.</h1>"));
            }

        } else {
            res.set('Content-Type', 'text/html');
            return res.send(Buffer.from("<h1>Failed to load page.</h1>"));
        }
    }

    return res.sendFile(path.join(__dirname, 'templates', 'index.html'));
});

app.get('/view', (req, res) => {
    if (req.query.pdf && /http[s]?:\/\/(?:[a-zA-Z]|[0-9]|[$-_@.&+]|[!*\(\),]|(?:%[0-9a-fA-F][0-9a-fA-F]))+/.test(req.query.pdf)) {
        return res.sendFile(path.join(__dirname, 'templates', 'view.html'));
    }

    res.status(400);
    res.set('Content-Type', 'text/html');
    res.send(Buffer.from("<h1>You shall not pass!!1</h1>"));
});

app.listen(PORT, callbackFn);

process.on('SIGINT', async () => {
    await pool.drain();
    await pool.clear();
    process.exit(0);
});