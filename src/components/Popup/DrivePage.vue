<template>
  <div>
    <div>
      <div class="text warning" v-show="!isEncrypted || !defaultEncryption">
        {{ i18n.dropbox_risk }}
      </div>
      <div v-show="backupToken">
        <div style="margin: 10px 0px 0px 20px; overflow-wrap: break-word">
          {{ i18n.account }} - {{ email }}
        </div>
      </div>
      <a-select-input
        v-show="!!defaultEncryption && backupToken"
        :label="i18n.encrypted"
        v-model="isEncrypted"
      >
        <option value="true">{{ i18n.yes }}</option>
        <option value="false">{{ i18n.no }}</option>
      </a-select-input>
      <a-button v-show="backupToken" @click="backupLogout()">
        {{ i18n.log_out }}
      </a-button>
      <a-button v-show="!backupToken" @click="getBackupToken()">
        {{ i18n.sign_in }}
      </a-button>
      <a-button v-show="backupToken" @click="backupUpload()">
        {{ i18n.manual_dropbox }}
      </a-button>
    </div>
  </div>
</template>
<script lang="ts">
import Vue from "vue";
import { hasChromeIdentity } from "../../browser";
import { Drive, getBackupEncryption } from "../../models/backup";
import { UserSettings } from "../../models/settings";

const service = "drive";

export default Vue.extend({
  data: function () {
    return {
      email: this.i18n.loading,
    };
  },
  created() {
    UserSettings.updateItems();
  },
  computed: {
    defaultEncryption: function () {
      return this.$store.state.accounts.defaultEncryption;
    },
    isEncrypted: {
      get(): boolean {
        if (UserSettings.items[`${service}Encrypted`] === null) {
          this.$store.commit("backup/setEnc", { service, value: true });
          UserSettings.items[`${service}Encrypted`] = true;
          UserSettings.commitItems();
          return true;
        }
        return this.$store.state.backup.driveEncrypted;
      },
      set(newValue: string) {
        UserSettings.items.driveEncrypted = newValue === "true";
        UserSettings.commitItems();
        this.$store.commit("backup/setEnc", {
          service,
          value: newValue === "true",
        });
      },
    },
    backupToken: function () {
      return this.$store.state.backup.driveToken;
    },
  },
  watch: {
    backupToken: async function (signedIn: boolean) {
      if (signedIn) {
        this.email = await this.getUser();
      }
    },
  },
  methods: {
    getBackupToken() {
      chrome.runtime.sendMessage({ action: service });
    },
    async backupLogout() {
      await UserSettings.updateItems();
      const token = UserSettings.items.driveToken;
      if (token) {
        try {
          await fetch(
            "https://accounts.google.com/o/oauth2/revoke?token=" +
              encodeURIComponent(token),
            { method: "POST" }
          );
        } catch (error) {
          console.error(error);
        }
        if (hasChromeIdentity) {
          await chrome.identity.removeCachedAuthToken({ token });
        }
      }
      UserSettings.items.driveToken = undefined;
      UserSettings.items.driveRefreshToken = undefined;
      await UserSettings.commitItems();
      this.$store.commit("backup/setToken", { service, value: false });
      this.$store.commit("style/hideInfo");
    },
    async backupUpload() {
      let response = false;
      try {
        response = await new Drive().upload(
          getBackupEncryption(this.$store.state.accounts)
        );
      } catch (error) {
        console.error(error);
      }
      await UserSettings.updateItems();
      if (response === true) {
        this.$store.commit("notification/alert", this.i18n.updateSuccess);
      } else if (UserSettings.items.driveRevoked === true) {
        this.$store.commit(
          "notification/alert",
          chrome.i18n.getMessage("token_revoked", ["Google Drive"])
        );
        UserSettings.removeItem("driveRevoked");
        this.$store.commit("backup/setToken", { service, value: false });
      } else {
        this.$store.commit("notification/alert", this.i18n.updateFailure);
      }
    },
    async getUser() {
      const drive = new Drive();
      return await drive.getUser();
    },
  },
  mounted: async function () {
    if (this.backupToken) {
      this.email = await this.getUser();
    }
  },
});
</script>
