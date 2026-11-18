const config = require('../config.json');
const fs = require('fs');
const path = require('path');
const { log } = require('../src/utils/log');

const VERSION = '1.0.0';
const APP_ID = 'event-watcher';

const DATABASE = [
    {
        table: 'app_eventwatcher_events',
        action: `CREATE TABLE app_eventwatcher_events(
            id INT NOT NULL AUTO_INCREMENT,
            name VARCHAR(64) NOT NULL,
            enabled BOOLEAN DEFAULT false,
            discordChannel TEXT,
            embedColor TEXT,
            roleID TEXT,
            pushover BOOLEAN DEFAULT false,
            customProducts TEXT,
            createdAt TEXT NOT NULL,
            PRIMARY KEY (id),
            UNIQUE (name))`,
    },
];

let db;
const domain = config.siteInformation.domain.replace(/\/$/, '');
const link = url => !url || String(url).startsWith('http') ? url : `${domain}${url}`;
// Core escapes quotes for SQL before it emits some events
const clean = text => String(text ?? '').replaceAll("''", "'").trim();
const money = amount => `${CACHE.settings?.currency || '$'}${Number(amount || 0).toFixed(2)}`;
const sum = items => (items || []).reduce((total, item) => total + Number(item.price || 0), 0);
const date = ms => Number(ms) ? `<t:${Math.floor(Number(ms) / 1000)}:D>` : null;
// Switches post a hidden "false" followed by the checkbox "true"
const last = value => Array.isArray(value) ? value[value.length - 1] : value;
const snowflake = value => /^\d{15,25}$/.test(String(last(value) ?? '').trim()) ? String(last(value)).trim() : '';
const colour = (value, fallback) => /^#[0-9a-f]{6}$/i.test(String(last(value))) ? last(value) : fallback;

// Each build returns the message for one event. Fields are [name, value, inline].
const EVENTS = {
    releaseCreate: {
        label: 'New release', group: 'Store', color: '#FDF35E', products: true,
        help: 'A new release is uploaded for a product.',
        build: (product, release) => ({
            productID: product.id,
            author: product.title,
            title: [clean(release.version), clean(release.title)].filter(Boolean).join(' — '),
            url: link(`/releases/${product.id}#${encodeURIComponent(clean(release.version))}`),
            thumbnail: product.featureImage,
            description: clean(release.changes),
            push: `${product.title} ${clean(release.version)} - ${clean(release.title)}`
        })
    },
    checkoutReturn: {
        label: 'New order', group: 'Store', color: '#44D121',
        help: 'A customer completes a checkout.',
        build: (user, paymentId, cart, total) => {
            const name = user?.username || user?.displayName;
            const products = (cart || []).map(item => CACHE.products?.find(p => p.id == parseInt(item))?.title || item);
            return {
                title: `New order for ${money(total)}`,
                url: link(`/user/${user?.id}`),
                fields: [['Customer', name], ['Total', money(total)], ['Payment', paymentId], ['Products', products.join('\n'), false]],
                push: `${name} ordered ${products.join(', ')} for ${money(total)}`
            };
        }
    },
    reviewCreated: {
        label: 'New review', group: 'Store', color: '#F5B301',
        help: 'A customer leaves a review.',
        build: (user, reviewId, review) => {
            const stars = Math.min(5, Math.max(0, Number(review.stars) || 0));
            return {
                author: user?.username,
                title: `${'★'.repeat(stars)}${'☆'.repeat(5 - stars)} ${clean(review.product)}`,
                url: link(`/review/${reviewId}`),
                description: clean(review.comment),
                push: `${user?.username} left ${stars} stars${review.product ? ` for ${clean(review.product)}` : ''}`
            };
        }
    },
    invoiceCreated: {
        label: 'Invoice created', group: 'Billing', color: '#00A6FF',
        help: 'Staff create an invoice for a customer.',
        build: (invoiceId, customer, staff, items, createdAt, due) => ({
            author: staff?.username,
            title: `Invoice #${invoiceId}`,
            url: link(`/invoice/${invoiceId}`),
            fields: [['Customer', customer?.username], ['Total', money(sum(items))], ['Due', date(due)], ['Items', (items || []).map(i => clean(i.title)).join('\n'), false]],
            push: `Invoice #${invoiceId} for ${customer?.username}, ${money(sum(items))}`
        })
    },
    invoicePaid: {
        label: 'Invoice paid', group: 'Billing', color: '#44D121',
        help: 'A customer pays an invoice.',
        build: async (invoiceId, paymentType, receiptId, payment, total) => {
            const [[invoice]] = await db.query('SELECT username FROM invoices WHERE id = ?', [invoiceId]);
            const method = {paypal: 'PayPal', stripe: 'Stripe', square: 'Square'}[paymentType] || paymentType;
            return {
                title: `Invoice #${invoiceId} paid`,
                url: link(`/invoice/${invoiceId}`),
                fields: [['Customer', invoice?.username], ['Total', money(total)], ['Method', method]],
                push: `${invoice?.username || 'A customer'} paid invoice #${invoiceId}, ${money(total)}`
            };
        }
    },
    subscriptionInvoiceCreated: {
        label: 'Subscription invoice', group: 'Billing', color: '#A36AD8',
        help: 'A renewal invoice is created for a subscription.',
        build: (invoiceId, customer, items, due) => ({
            title: `Invoice #${invoiceId}`,
            url: link(`/invoice/${invoiceId}`),
            fields: [['Customer', customer?.username], ['Total', money(sum(items))], ['Due', date(due)], ['Items', (items || []).map(i => clean(i.title)).join('\n'), false]],
            push: `Renewal invoice #${invoiceId} for ${customer?.username}, ${money(sum(items))}`
        })
    },
    quoteAccepted: {
        label: 'Quote accepted', group: 'Billing', color: '#2DD4BF',
        help: 'A customer accepts a quote.',
        build: async (userId, quoteId) => {
            const [[quote]] = await db.query('SELECT title, price FROM quotes WHERE id = ?', [quoteId]);
            const [[user]] = await db.query('SELECT username FROM users WHERE userId = ?', [userId]);
            return {
                title: `Quote #${quoteId} accepted`,
                url: link(`/quote/${quoteId}`),
                fields: [['Customer', user?.username || userId], ['Quote', quote?.title], ['Price', money(quote?.price)]],
                push: `${user?.username || 'A customer'} accepted quote #${quoteId}, ${quote?.title || ''}`
            };
        }
    },
    createUserAccount: {
        label: 'New account', group: 'Community', color: '#00A6FF',
        help: 'Someone creates an account.',
        build: (user, provider) => {
            const name = user?.username || user?.displayName;
            const via = {discord: 'Discord', google: 'Google', github: 'GitHub', local: 'Email'}[provider] || provider;
            return {
                title: `${name} joined`,
                url: link(`/user/${user?.id}`),
                fields: [['Signed up with', via]],
                push: `${name} created an account with ${via}`
            };
        }
    },
    formSubmitted: {
        label: 'Form submitted', group: 'Community', color: '#F97316',
        help: 'Someone submits one of your forms.',
        build: (user, submissionId, form, answers) => ({
            author: user?.username,
            title: form?.title,
            url: link(`/formsub/${submissionId}`),
            description: (answers || []).map(a => `**${a.q}**\n${String(a.a || '-').replace(/<br \/>/g, '\n')}`).join('\n\n'),
            push: `${user?.username} submitted ${form?.title}`
        })
    },
    blogpostCreate: {
        label: 'New blog post', group: 'Community', color: '#FF6B8B',
        help: 'A blog post is published.',
        build: async (userId, post) => {
            const [[user]] = await db.query('SELECT username FROM users WHERE userId = ?', [userId]);
            const text = clean(post.blogcontent).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
            return {
                author: user?.username,
                title: clean(post.title),
                url: link(`/blog/b/${post.urlId}`),
                image: post.image,
                description: text.length > 300 ? `${text.slice(0, 300)}...` : text,
                push: clean(post.title)
            };
        }
    },
};

module.exports = async function(app, connection, bot, faxstore) {
    // The helpers below arrived in FaxStore 3.4.0. Older versions ignore the manifest's minimum version, so check here too.
    if(typeof faxstore.apps.migrate !== 'function') return log(`@BOLD@RED[EVENT WATCHER]: @RESETEvent Watcher needs FaxStore 3.4.0 or newer. Update FaxStore to use it.`);
    db = connection.promise();

    // Register FaxStore App
    faxstore.apps.register({
        id: APP_ID,
        name: 'Event Watcher',
        version: VERSION,
        author: 'FAXES',
        description: 'Listens for FaxStore events and sends them to Discord channels and Pushover.',
        icon: 'binoculars',
        url: 'https://apps.faxstore.info/app/event-watcher',
        staffPage: {name: 'Event Watcher', link: '/staff/event-watcher/configure', icon: 'binoculars', id: APP_ID}
    }, __filename);

    // Build & Update Database
    setTimeout(async () => {
        try {
            await faxstore.apps.migrate(APP_ID, DATABASE);

            // Stores that used the old Release Watcher config get it copied across once
            const legacy = path.join(__dirname, 'configs', 'releaseWatcher.json');
            const [existing] = await db.query(`SELECT id FROM app_eventwatcher_events WHERE name = 'releaseCreate'`);
            if(!existing.length && fs.existsSync(legacy)) {
                const old = JSON.parse(fs.readFileSync(legacy, 'utf8'));
                await db.query('INSERT INTO app_eventwatcher_events (name, enabled, discordChannel, embedColor, roleID, pushover, customProducts, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    ['releaseCreate', true, old.releaseChannel || '', EVENTS.releaseCreate.color, '', false, JSON.stringify(old.customProducts || []), Date.now()]);
            }
        } catch(err) {
            log(`@BOLD@RED[EVENT WATCHER]: @RESETDatabase setup failed - ${err.message}`);
        }
    }, 2000);

    // Staff page assets, the minified copies are used outside developer mode
    const assets = faxstore.apps.assets(APP_ID, path.join(__dirname, 'eventwatcher', 'client'), {route: '/eventwatcher/assets'});
    const asset = file => assets.url(file);

    // Push notifications go through the Pushover app. It's looked up each time as apps load in parallel.
    const pushover = () => {
        const p = faxstore.apps.get('pushover');
        return typeof p?.api?.send === 'function' ? p.api : null;
    };

    // Settings GET
    app.get('/staff/event-watcher/configure', function(req, res) {
        getUserInfo(req, res, async function(userData) {
            try {
                const [[settings]] = await db.query('SELECT * FROM sitesettings WHERE id = 1');
                if(!hasPermission(userData, 'OWNER')) return res.render('utils/403', {userInfo: userData, siteInfo: settings});
                const [rows] = await db.query('SELECT * FROM app_eventwatcher_events');
                const [products] = await db.query('SELECT id, title FROM storeitems ORDER BY title ASC');
                const guild = faxstore.discord?.guild;
                const events = Object.entries(EVENTS).map(([name, e]) => {
                    const row = rows.find(r => r.name === name) || {};
                    return {
                        name, label: e.label, help: e.help, group: e.group, products: !!e.products,
                        enabled: !!row.enabled, discordChannel: row.discordChannel || '', embedColor: row.embedColor || e.color,
                        roleID: row.roleID || '', pushover: !!row.pushover, customProducts: JSON.parse(row.customProducts || '[]')
                    };
                });
                res.render('apps/event-watcher', {user: userData, settings, ew: {
                    events,
                    products,
                    tab: Object.hasOwn(EVENTS, req.query.tab) ? req.query.tab : 'releaseCreate',
                    pushoverReady: !!pushover(),
                    discordReady: !!guild,
                    channels: guild ? [...guild.channels.cache.filter(c => c.type === 0 || c.type === 5).values()].map(c => ({id: c.id, name: c.name})).sort((a, b) => a.name.localeCompare(b.name)) : [],
                    roles: guild ? [...guild.roles.cache.filter(r => r.id !== guild.id && !r.managed).values()].sort((a, b) => b.position - a.position).map(r => ({id: r.id, name: r.name})) : [],
                    assets: {css: asset('staff.css'), js: asset('staff.js')}
                }});
            } catch(err) {
                if(config.siteInformation?.developerMode) console.error(err);
                res.redirect(`/staff?n=${encodeURIComponent('Unable to load Event Watcher.')}&nc=red`);
            }
        });
    });

    // Settings POST
    app.post('/backend/event-watcher/configure', function(req, res) {
        getUserInfo(req, res, async function(userData) {
            if(!hasPermission(userData, 'OWNER')) return res.redirect('/403');
            const b = req.body || {};
            const tab = Object.hasOwn(EVENTS, b.tab) ? b.tab : 'releaseCreate';
            try {
                const [existing] = await db.query('SELECT name FROM app_eventwatcher_events');
                for(const [name, e] of Object.entries(EVENTS)) {
                    // Product override rows post their fields as lists in the same order
                    const list = key => [].concat(b[`${name}.${key}`] ?? []);
                    const products = list('productID').map((id, i) => ({
                        productID: Number(id) || 0,
                        embedColor: colour(list('productColor')[i], e.color),
                        roleID: snowflake(list('productRole')[i]),
                        channelID: snowflake(list('productChannel')[i])
                    })).filter(p => p.productID > 0);
                    const values = [last(b[`${name}.enabled`]) === 'true', snowflake(b[`${name}.discordChannel`]), colour(b[`${name}.embedColor`], e.color), snowflake(b[`${name}.roleID`]), last(b[`${name}.pushover`]) === 'true', JSON.stringify(products)];
                    if(existing.some(r => r.name === name)) await db.query('UPDATE app_eventwatcher_events SET enabled = ?, discordChannel = ?, embedColor = ?, roleID = ?, pushover = ?, customProducts = ? WHERE name = ?', [...values, name]);
                    else await db.query('INSERT INTO app_eventwatcher_events (enabled, discordChannel, embedColor, roleID, pushover, customProducts, name, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [...values, name, Date.now()]);
                }
                createAuditLog(userData.id, 'Updated Event Watcher', 'has updated the Event Watcher settings.');
                res.redirect(`/staff/event-watcher/configure?tab=${tab}&n=${encodeURIComponent('Event Watcher settings saved.')}&nc=green`);
            } catch(err) {
                if(config.siteInformation?.developerMode) console.error(err);
                res.redirect(`/staff/event-watcher/configure?tab=${tab}&n=${encodeURIComponent('Unable to save settings.')}&nc=red`);
            }
        });
    });

    // Send a test using what's on the page, saved or not
    app.post('/backend/event-watcher/test', function(req, res) {
        getUserInfo(req, res, async function(userData) {
            if(!hasPermission(userData, 'OWNER')) return res.status(403).json({sent: [], errors: ['Not authorised.']});
            const b = req.body || {};
            if(!Object.hasOwn(EVENTS, b.event)) return res.status(400).json({sent: [], errors: ['Unknown event.']});
            const e = EVENTS[b.event];
            const result = await send(e.label, {
                title: `Test: ${e.label}`,
                description: 'Event Watcher is working. This event will be sent here.',
                url: domain,
                push: `Test: ${e.label}. This event will be sent here.`
            }, {
                discordChannel: snowflake(b.discordChannel),
                embedColor: colour(b.embedColor, e.color),
                pushover: b.pushover === true
            });
            if(!result.sent.length && !result.errors.length) result.errors.push('Pick a Discord channel or turn on Pushover first.');
            res.json(result);
        });
    });

    // Listen for every event and send it where it's configured
    for(const name of Object.keys(EVENTS)) {
        faxstore.on(name, async function(...args) {
            try {
                const [[row]] = await db.query('SELECT * FROM app_eventwatcher_events WHERE name = ?', [name]);
                if(!row?.enabled) return;
                const message = await EVENTS[name].build(...args);
                const result = await send(EVENTS[name].label, message, {...row, customProducts: JSON.parse(row.customProducts || '[]')});
                result.errors.forEach(error => log(`@BOLD@RED[EVENT WATCHER]: @RESET${name} - ${error}`));
            } catch(err) {
                log(`@BOLD@RED[EVENT WATCHER]: @RESET${name} - ${err.message}`);
            }
        });
    }

    async function send(label, message, options) {
        const sent = [], errors = [];
        const custom = (options.customProducts || []).find(p => message.productID && p.productID == message.productID) || {};
        const channelID = custom.channelID || options.discordChannel;
        const roleID = custom.roleID || options.roleID;

        if(channelID) {
            try {
                const channel = faxstore.discord?.bot?.channels?.cache.get(channelID);
                if(!channel) throw new Error(`channel ${channelID} wasn't found. Check the bot is in your server and can see it.`);
                await channel.send({
                    content: roleID ? `<@&${roleID}>` : undefined,
                    allowedMentions: {roles: roleID ? [roleID] : []},
                    embeds: [{
                        color: parseInt(String(custom.embedColor || options.embedColor || '#00A6FF').slice(1), 16),
                        author: message.author ? {name: String(message.author).slice(0, 256)} : undefined,
                        title: String(message.title || label).slice(0, 256),
                        url: message.url || undefined,
                        description: message.description ? String(message.description).slice(0, 4000) : undefined,
                        fields: (message.fields || []).filter(f => f[1]).map(f => ({name: f[0], value: String(f[1]).slice(0, 1024), inline: f[2] !== false})),
                        thumbnail: message.thumbnail ? {url: link(message.thumbnail)} : undefined,
                        image: message.image ? {url: link(message.image)} : undefined,
                        footer: CACHE.settings?.sitename ? {text: CACHE.settings.sitename} : undefined,
                        timestamp: new Date().toISOString()
                    }]
                });
                sent.push('Discord');
            } catch(err) {
                errors.push(`Discord: ${err.message}`);
            }
        }

        if(options.pushover) {
            try {
                const api = pushover();
                if(!api) throw new Error('install the Pushover app to send push notifications.');
                await api.send({title: label, message: String(message.push || message.title || label).slice(0, 1024), url: message.url});
                sent.push('Pushover');
            } catch(err) {
                errors.push(`Pushover: ${err.message}`);
            }
        }
        return {sent, errors};
    }
};
