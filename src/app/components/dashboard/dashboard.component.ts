/* 
 *  // Copyright (C) 2020 - 2021 Bitfly GmbH
 *  // Manuel Caspari (manuel@bitfly.at)
 *  // 
 *  // This file is part of Beaconchain Dashboard.
 *  // 
 *  // Beaconchain Dashboard is free software: you can redistribute it and/or modify
 *  // it under the terms of the GNU General Public License as published by
 *  // the Free Software Foundation, either version 3 of the License, or
 *  // (at your option) any later version.
 *  // 
 *  // Beaconchain Dashboard is distributed in the hope that it will be useful,
 *  // but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  // MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  // GNU General Public License for more details.
 *  // 
 *  // You should have received a copy of the GNU General Public License
 *  // along with Beaconchain Dashboard.  If not, see <http://www.gnu.org/licenses/>.
 */

import { Component, OnInit, Input, SimpleChange } from '@angular/core';
import { UnitconvService } from '../../services/unitconv.service';
import { ApiService } from '../../services/api.service';
import { DasboardDataRequest, EpochResponse } from '../../requests/requests';
import * as HighCharts from 'highcharts';
import * as Highstock from "highcharts/highstock";
import BigNumber from "bignumber.js";
import { OverviewData } from '../../controllers/OverviewController';
import { Release } from '../../utils/ClientUpdateUtils';
import ThemeUtils from 'src/app/utils/ThemeUtils';
import { highChartOptions } from 'src/app/utils/HighchartOptions';
import { StorageService } from 'src/app/services/storage.service';
import confetti from 'canvas-confetti';
import { Browser } from '@capacitor/browser';
import { ModalController } from '@ionic/angular';
import { SubscribePage } from 'src/app/pages/subscribe/subscribe.page';
import { MerchantUtils } from 'src/app/utils/MerchantUtils';

@Component({
  selector: 'app-validator-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss']
})
export class DashboardComponent implements OnInit {

  @Input() data?: OverviewData;
  @Input() updates?: Release[];
  @Input() currentY: number;
  @Input() scrolling: boolean;

  fadeIn = "invisible"

  beaconChainUrl: string = null
  finalizationIssue = false
  awaitGenesis = false
  earlyGenesis = false
  utilizationAvg: number = -1

  chartData
  chartDataProposals
  chartError = false
  currencyPipe = null

  readonly randomChartId

  rankPercentMode = false

  selectedChart = "chartIncome"

  showFirstProposalMsg = false
  firstCelebrate = true

  doneLoading = false
  proposals: Proposals = null
  currentPackageMaxValidators = 100

  constructor(
    public unit: UnitconvService,
    public api: ApiService,
    public theme: ThemeUtils,
    private storage: StorageService,
    private modalController: ModalController,
    private merchant: MerchantUtils
  ) {
    this.randomChartId = getRandomInt(Number.MAX_SAFE_INTEGER)
  }

  async ngOnChanges(event) {
    if (event.data && event.data instanceof SimpleChange) {
      if (event.data.currentValue) {
        this.chartError = false
        this.chartData = null
        this.doneLoading = event.data.currentValue != null
          this.fadeIn = "fade-in"
          setTimeout(() => {
            this.fadeIn = null
          }, 1500)

        this.drawBalanceChart()
        this.drawProposalChart()
        this.beaconChainUrl = await this.getBaseBrowserUrl()

        if (!this.data.foreignValidator) {
          this.checkForFinalization()
          this.checkForGenesisOccured()
        }
      }
    }
  }

  ngOnInit() {
    this.doneLoading = false
    this.storage.getBooleanSetting("rank_percent_mode", false).then((result) => this.rankPercentMode = result)
    highChartOptions(HighCharts)
    highChartOptions(Highstock)
    this.merchant.getCurrentPlanMaxValidator().then((result) => { this.currentPackageMaxValidators = result })
  }

  async checkForGenesisOccured() {
    if (!this.data || !this.data.currentEpoch) return
    const currentEpoch = this.data.currentEpoch as EpochResponse
    this.awaitGenesis = currentEpoch.epoch == 0 && currentEpoch.proposedblocks <= 1
    this.earlyGenesis = !this.awaitGenesis && !this.finalizationIssue && currentEpoch.epoch <= 7
  }

  async checkForFinalization() {
    if (!this.data || !this.data.currentEpoch) return
    const currentEpoch = this.data.currentEpoch as EpochResponse
    this.finalizationIssue = new BigNumber(currentEpoch.globalparticipationrate).isLessThan("0.664") && currentEpoch.epoch > 7
  }

  async getChartData(data: ('balances' | 'proposals')) {
    if (!this.data || !this.data.lazyChartValidators) return null
    const chartReq = new DasboardDataRequest(data, this.data.lazyChartValidators)
    const response = await this.api.execute(chartReq).catch((error) => { return null })
    if (!response) {
      this.chartError = true
      return null
    }
    return chartReq.parse(response)
  }

  async upgrade() {
    const modal = await this.modalController.create({
      component: SubscribePage,
      cssClass: 'my-custom-class',
      componentProps: {
        'tab': 'whale'
      }
    });
    return await modal.present();
  }

  switchCurrencyPipe() {
    if (this.unit.pref == "ETHER") {
      if (this.currencyPipe == null) return
      this.unit.pref = this.currencyPipe
    }
    else {
      this.currencyPipe = this.unit.pref
      this.unit.pref = "ETHER"
    }
  }

  async drawProposalChart() {
    this.chartDataProposals = await this.getChartData("proposals")

    if (!this.chartDataProposals || this.chartDataProposals.length < 1) {
      this.chartDataProposals = false
      return
    }

    var proposed = []
    var missed = []
    var orphaned = []
    this.chartDataProposals.map(d => {
      if (d[1] == 1) proposed.push([d[0] * 1000, 1])
      else if (d[1] == 2) missed.push([d[0] * 1000, 1])
      else if (d[1] == 3) orphaned.push([d[0] * 1000, 1])
    })

    this.proposals = {
      good: proposed.length,
      bad: missed.length + orphaned.length
    }

    this.checkForFirstProposal(proposed)

    this.createProposedChart(proposed, missed, orphaned)
  }

  private async checkForFirstProposal(chartData) {
    if (this.data.foreignValidator) return
    const foundAtLeasOne = chartData.length >= 1 && chartData.length <= 2
    const noPreviousFirstProposal = await this.storage.getBooleanSetting("first_proposal_executed", false)
    if (foundAtLeasOne && !noPreviousFirstProposal) {
      this.showFirstProposalMsg = true

      if (this.firstCelebrate) {
        setTimeout(() => {
          confetti({
            particleCount: 30,
            spread: 50,
            origin: { y: 0.41 }
          });
        }, 800)

      }
      this.firstCelebrate = false
    }
  }

  async drawBalanceChart() {
    this.chartData = await this.getChartData("balances")

    if (!this.chartData || this.chartData.length <= 3) {
      this.chartError = true;
      this.doneLoading = true
      return
    }

    this.chartError = false;
    setTimeout(() => { this.doneLoading = true }, 50)


    this.createBalanceChart(this.calculateIncomeData(this.chartData))
  }


  private calculateIncomeData(balance) {
    var income = [];
    for (var i = 0; i < balance.length; i++) {
        let color = balance[i].y < 0 ? "#ff835c" : "var(--chart-default)";
        income.push({ x: balance[i].x, y: balance[i].y, color: color })
    }
    return income;
  }

  private averageUtilization(data: number[]) {
    if (!data || data.length <= 0) return -1
    var sum = 0

    data.forEach((item) => {
      sum += item[1]
    })
    const avg = sum * 100 / data.length

    return avg
  }

  switchRank() {
    this.rankPercentMode = !this.rankPercentMode
    this.storage.setBooleanSetting("rank_percent_mode", this.rankPercentMode)
  }

  createProposedChart(proposed, missed, orphaned) {
    // @ts-ignore     ¯\_(ツ)_/¯
    const chart = Highstock.stockChart('highchartsBlocks' + this.randomChartId, {
      chart: {
        type: 'column',
      },
      legend: {
        enabled: true
      },
      title: {
        text: '' //Balance History for all Validators
      },
      colors: ["var(--chart-default)", "#ff835c", "#e4a354", "#2b908f", "#f45b5b", "#91e8e1"],
      xAxis: {
        lineWidth: 0,
        tickColor: '#e5e1e1',
        type: 'datetime',
        range: 32 * 24 * 60 * 60 * 1000,
      },
      yAxis: [
        {
          title: {
            text: ''
          },
          allowDecimals: false,
          opposite: false
        }
      ],
      tooltip: {
        style: {
          color: 'var(--text-color)',
          fontWeight: 'bold'
        }
      },
      plotOptions: {
        series: {

          dataGrouping: {
            units: [
              ["day", [1]]
            ],
            forced: true,
            enabled: true,
            groupAll: true
          }
        }
      },
      series: [
        {
          name: 'Proposed',
          color: 'var(--chart-default)',
          data: proposed,
          pointWidth: 5,
        },
        {
          name: 'Missed',
          color: '#ff835c',
          data: missed,
          pointWidth: 5,
        },
        {
          name: 'Orphaned',
          color: '#e4a354',
          data: orphaned,
          pointWidth: 5,
        }
      ],
      rangeSelector: {
        enabled: false
      },
      scrollbar: {
        enabled: false
      },
      navigator: {
        enabled: true
      }
    })
  }

  async createBalanceChart(income) {
    const genesisTs = (await this.api.networkConfig).genesisTs

    // @ts-ignore     ¯\_(ツ)_/¯
    Highstock.stockChart('highcharts' + this.randomChartId, {

      exporting: {
        scale: 1
      },
      rangeSelector: {
        enabled: false
      },
      scrollbar: {
        enabled: false
      },
      navigator: {
        enabled: true
      },
      chart: {
        type: 'column',
      },
      legend: {
        enabled: true
      },
      title: {
        text: '' //Balance History for all Validators
      },
      xAxis: {

       // tickInterval: 24 * 3600 * 1000,
        //tickmarkPlacement: 'on',

        range: 32 * 24 * 60 * 60 * 1000,
        type: 'datetime',
      },
      tooltip: {
        style: {
          color: 'var(--text-color)',
          fontWeight: 'bold'
        },
        formatter: (tooltip) => {
          const value = new BigNumber(tooltip.chart.hoverPoint.y);

          return `Income: ${value.toFormat(6)} Ether<br/><span style="font-size:11px;">${this.unit.convertToPref(value, "ETHER")}</span><br/><br/><span style="font-size:11px;">${ new Date(tooltip.chart.hoverPoint.x).toLocaleString()}</span>`
        }
      },
      yAxis: [
        {
          title: {
            text: ''
          },
          opposite: false,
          labels: {
            formatter: function () {
              return this.value.toFixed(2)
            },

          }
        }
      ],
      series: [
        {
      
          name: 'Income',
          data: income
        }
      ]
    })
  }


  async openBrowser() {
    await Browser.open({ url: await this.getBrowserURL(), toolbarColor: "#2f2e42" });
  }

  async getBrowserURL(): Promise<string> {
    if (this.data.foreignValidator) {
      return (await this.getBaseBrowserUrl()) + "/validator/" + this.data.foreignValidatorItem.pubkey
    } else {
      return (await this.getBaseBrowserUrl()) + "/dashboard?validators=" + this.data.lazyChartValidators
    }
  }

  async getBaseBrowserUrl() {
    const net = (await this.api.networkConfig).net
    return "https://" + net + "beaconcha.in"
  }

}

function timeToEpoch(genesisTs, ts) {
  var gts = genesisTs
  var sps = 12
  var spe = 32
  var slot = Math.floor((ts / 1000 - gts) / sps)
  var epoch = Math.floor(slot / spe)
  if (epoch < 0) return 0
  return epoch
}

function getRandomInt(max) {
  return Math.floor(Math.random() * Math.floor(max));
}

interface Proposals {
  good: number
  bad: number
}