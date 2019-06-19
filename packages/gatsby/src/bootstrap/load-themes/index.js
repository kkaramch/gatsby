const path = require(`path`)
const fs = require(`fs-extra`)
const mergeGatsbyConfig = require(`../../utils/merge-gatsby-config`)
const Promise = require(`bluebird`)
const _ = require(`lodash`)
const debug = require(`debug`)(`gatsby:load-themes`)
const preferDefault = require(`../prefer-default`)
const getConfigFile = require(`../get-config-file`)
const loadPlugins = require(`../load-plugins/load`)

// get the gatsby-config file for a theme
const resolveTheme = async themeSpec => {
  const themeName = themeSpec.resolve || themeSpec
  const themeDir = path.dirname(require.resolve(themeName))
  const theme = await preferDefault(getConfigFile(themeDir, `gatsby-config`))
  // if theme is a function, call it with the themeConfig
  let themeConfig = theme
  if (_.isFunction(theme)) {
    themeConfig = theme(themeSpec.options || {})
  }
  return { themeName, themeConfig, themeSpec, themeDir }
}

// single iteration of a recursive function that resolve parent themes
// It's recursive because we support child themes declaring parents and
// have to resolve all the way `up the tree` of parent/children relationships
//
// Theoretically, there could be an infinite loop here but in practice there is
// no use case for a loop so I expect that to only happen if someone is very
// off track and creating their own set of themes
const processTheme = ({ themeName, themeConfig, themeSpec, themeDir }) => {
  // gatsby themes don't have to specify a gatsby-config.js (they might only use gatsby-node, etc)
  // in this case they're technically plugins, but we should support it anyway
  // because we can't guarentee which files theme creators create first
  if (themeConfig && themeConfig.__experimentalThemes) {
    // for every parent theme a theme defines, resolve the parent's
    // gatsby config and return it in order [parentA, parentB, child]
    return Promise.mapSeries(themeConfig.__experimentalThemes, async spec => {
      const themeObj = await resolveTheme(spec)
      return processTheme(themeObj)
    }).then(arr =>
      arr.concat([{ themeName, themeConfig, themeSpec, themeDir }])
    )
  } else {
    // if a theme doesn't define additional themes, return the original theme
    return [{ themeName, themeConfig, themeSpec, themeDir }]
  }
}

module.exports = async (config = {}, rootDir = null) => {
  const plugins = loadPlugins(config, rootDir)

  const themesConfig = plugins
    .filter(
      theme => {
        return theme.name !== `default-site-plugin` &&
          fs.existsSync(path.join(theme.resolve, `gatsby-config.js`))
      }
    )
    .map(theme => {
      return config.plugins.find(
        plugin =>
          plugin === theme.name || plugin.resolve === theme.name || plugin.resolve === theme.resolve
      )
    }).concat(config.__experimentalThemes || [])

  if (!themesConfig.length) {
    return Promise.resolve()
  }

  const themesA = await Promise.mapSeries(themesConfig, async themeSpec => {
    const themeObj = await resolveTheme(themeSpec)
    return processTheme(themeObj)
  }).then(arr => _.flattenDeep(arr))

  // log out flattened themes list to aid in debugging
  debug(themesA)

  // map over each theme, adding the theme itself to the plugins
  // list in the config for the theme. This enables the usage of
  // gatsby-node, etc in themes.
  return (
    Promise.mapSeries(themesA, ({ themeName, themeConfig = {}, themeSpec }) => {
      return {
        ...themeConfig,
        plugins: [
          ...(themeConfig.plugins || []),
          // theme plugin is last so it's gatsby-node, etc can override it's declared plugins, like a normal site.
          { resolve: themeName, options: themeSpec.options || {} },
        ],
      }
    })
      /**
       * themes resolve to a gatsby-config, so here we merge all of the configs
       * into a single config, making sure to maintain the order in which
       * they were defined so that later configs, like the user's site and
       * children, can override functionality in earlier themes.
       */
      .reduce(mergeGatsbyConfig, {})
      .then(newConfig => {
        return {
          config: mergeGatsbyConfig(newConfig, config),
          themes: themesA,
        }
      })
  )
}
