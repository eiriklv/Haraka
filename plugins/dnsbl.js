// dnsbl plugin

var reject=true;

exports.register = function() {
    this.inherits('dns_list_base');

    var cfg = this.refresh_config();  // every connection
    this.get_uniq_zones();            // only once

    if (cfg.main.periodic_checks) {
        this.check_zones(cfg.main.periodic_checks);
    }

    if (cfg.main.search && cfg.main.search === 'all') {
        this.register_hook('connect',  'connect_multi');
    }
    else {
        this.register_hook('connect',  'connect_first');
    }
};

exports.refresh_config = function () {
    var cfg = this.config.get('dnsbl.ini', {
        booleans: ['main.reject', 'main.enable_stats'],
    });

    if (cfg.main.reject !== undefined) {
        if (cfg.main.reject && !reject) {
            this.loginfo('reject enabled per config: ' + cfg.main.reject);
            reject = true;
        }
        if (!cfg.main.reject && reject) {
            this.loginfo('reject disabled per config: ' + cfg.main.reject);
            reject = false;
        }
    }

    if (cfg.main.enable_stats !== undefined) {
        if (cfg.main.enable_stats && !this.enable_stats) {
            this.loginfo('stats reporting enabled');
            this.enable_stats = true;
        }
        if (!cfg.main.enable_stats && this.enable_stats) {
            this.loginfo('stats reporting disabled');
            this.enable_stats = false;
        }
    }

    if (cfg.main.stats_redis_host && cfg.main.stats_redis_host !== this.redis_host) {
        this.redis_host = cfg.main.stats_redis_host;
        this.loginfo('set stats redis host to: ' + this.redis_host);
    }

    this.cfg = cfg;
    return cfg;
};

exports.get_uniq_zones = function () {
    var plugin = this;
    plugin.zones = [];

    var unique_zones = {};

    // Compatibility with old-plugin
    var legacy_zones = this.config.get('dnsbl.zones', 'list');
    for (var i=0; i < legacy_zones.length; i++) {
        unique_zones[legacy_zones[i]] = true;
    }

    if (!plugin.cfg) plugin.refresh_config();

    if (plugin.cfg.main.zones) {
        var new_zones = plugin.cfg.main.zones.split(/[\s,;]+/);
        for (var h=0; h < new_zones.length; h++) {
            unique_zones[new_zones[h]] = true;
        }
    }

    for (var key in unique_zones) { this.zones.push(key); }
    return this.zones;
};

exports.connect_first = function(next, connection) {

    if (!this.zones || !this.zones.length) {
        connection.logerror(this, "no zones");
        return next();
    }

    this.refresh_config();

    var plugin = this;
    this.first(connection.remote_ip, this.zones, function (err, zone, a) {
        if (err) {
            connection.logerror(plugin, err);
            return next();
        }
        if (!a) return next();

        var msg = 'host [' + connection.remote_ip + '] is blacklisted by ' + zone;
        if (reject) return next(DENY, msg);

        connection.loginfo(plugin, msg);
        return next();
    });
};

exports.connect_multi = function(next, connection) {
    var plugin = this;

    if (!plugin.zones || !plugin.zones.length) {
        connection.logerror(plugin, "no enabled zones");
        return next();
    }

    plugin.refresh_config();

    var hits = [];
    plugin.multi(connection.remote_ip, plugin.zones, function (err, zone, a, pending) {
        if (err) {
            connection.results.add(plugin, {err: err});
            if (pending > 0) return;
            if (reject && hits.length) return next(DENY,
                'host [' + connection.remote_ip + '] is blacklisted by ' + hits.join(', '));
            return next();
        }

        if (a) {
            hits.push(zone);
            connection.results.add(plugin, {fail: zone});
        }
        else {
            connection.results.add(plugin, {pass: zone});
        }

        if (pending > 0) return;
        connection.results.add(plugin, {emit: true});

        if (reject && hits.length) return next(DENY,
            'host [' + connection.remote_ip + '] is blacklisted by ' + hits.join(', '));
        return next();
    });
};
